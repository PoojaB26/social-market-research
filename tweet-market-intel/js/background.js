// background.js — handles Anthropic API calls, digest generation, Slack integration

function sanitizeForJSON(text) {
  // Remove emojis, special unicode, and control characters that break JSON
  return text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')  // control chars
    .replace(/\\/g, '\\\\')  // escape backslashes
    .replace(/"/g, '\\"')     // escape quotes
    .replace(/\n/g, ' ')      // newlines to spaces
    .replace(/\r/g, '')       // remove carriage returns
    .replace(/\t/g, ' ')      // tabs to spaces
    .trim()
    .slice(0, 500);           // limit length
}

const DAILY_LIMIT = 1000;
const MAX_STORED_TWEETS = 500;
const MAX_DIGESTS = 12;

const PRODUCT_CONTEXT = `Our product is FF Designer — an AI-powered design tool with the tagline "Design at the speed of thought."

Key capabilities:
- Generate & Refine: Type a prompt, get real-time streamed UI designs. Multiple design directions per generation. Follow-up prompts to refine. Supports phone/tablet/desktop presets. Attach reference images alongside prompts.
- Infinite Canvas: Pan, zoom, infinite workspace. Minimap navigation. Viewport & selections saved in URL for sharing.
- Direct Editing: Inline text editing on canvas. Contextual properties panel. Full color picker with eyedropper and recent colors. Material icons library built in.
- Design Tokens: Live-editable theme system (colors, typography, spacing, radii, shadows). Scale adjustments via sliders with instant ripple across all screens. Theme presets with customization.
- Storyboarding: Frames panel for bird's-eye view of flows. Hierarchical layer tree with drag reorder/reparent. 100-step undo with human-readable labels.
- Share & Export: Public shareable links. Export to FlutterFlow. Download as PNG or ZIP with docs.
- Cross-platform: Dark/light mode. Mobile-optimized experience. Native macOS touches.

Competitors and adjacent tools: Figma, Framer, Webflow, v0 by Vercel, Bolt, Lovable, Galileo AI, Uizard, Canva, Adobe XD, Sketch, FlutterFlow, Builder.io.`;


function getTodayKey() {
  return 'dailyCount_' + new Date().toISOString().slice(0, 10);
}

async function getDailyCount() {
  const key = getTodayKey();
  return new Promise(resolve => {
    chrome.storage.local.get([key], (data) => {
      resolve(data[key] || 0);
    });
  });
}

async function incrementDailyCount() {
  const key = getTodayKey();
  const count = await getDailyCount();
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: count + 1 }, () => {
      resolve(count + 1);
    });
  });
}

// --- Digest alarm setup ---

function setupDigestAlarm() {
  chrome.alarms.create('digest-check', { periodInMinutes: 60 });
}

chrome.runtime.onInstalled.addListener(() => {
  setupDigestAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupDigestAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'digest-check') {
    handleDigestAlarm();
  }
});

async function handleDigestAlarm() {
  // Check if today matches the configured digest day
  const settings = await new Promise(resolve => {
    chrome.storage.local.get(['digestDay', 'apiKey', 'slackWebhookUrl', 'lastDigestRun'], (data) => {
      resolve(data);
    });
  });

  const today = new Date().getDay(); // 0=Sunday, 1=Monday, ...
  const digestDay = settings.digestDay != null ? settings.digestDay : 1; // default Monday

  if (today !== digestDay) return;

  // Check if we already ran today
  const todayStr = new Date().toISOString().slice(0, 10);
  if (settings.lastDigestRun === todayStr) return;

  if (!settings.apiKey) return;

  // Load tweets from the past 7 days
  const allTweets = await new Promise(resolve => {
    chrome.storage.local.get(['foundTweets'], (data) => {
      resolve(data.foundTweets || []);
    });
  });

  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentTweets = allTweets.filter(t => {
    const ts = t.foundAt ? new Date(t.foundAt).getTime() : 0;
    return ts >= oneWeekAgo;
  });

  if (recentTweets.length === 0) {
    // Mark as run so we don't keep checking
    chrome.storage.local.set({ lastDigestRun: todayStr });
    return;
  }

  try {
    const digest = await generateDigest(settings.apiKey, recentTweets);
    await saveDigest(digest);
    chrome.storage.local.set({ lastDigestRun: todayStr });

    // Auto-send to Slack if configured
    if (settings.slackWebhookUrl) {
      await sendToSlack(settings.slackWebhookUrl, digest.markdown);
      // Mark digest as sent
      const history = await new Promise(resolve => {
        chrome.storage.local.get(['digestHistory'], (data) => {
          resolve(data.digestHistory || []);
        });
      });
      const updated = history.map(d => {
        if (d.id === digest.id) {
          return { ...d, slackSent: true, slackSentAt: new Date().toISOString() };
        }
        return d;
      });
      chrome.storage.local.set({ digestHistory: updated });
    }
  } catch (err) {
    console.error('[Tweet Market Intel] Digest alarm error:', err);
  }
}

// --- Message listener ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CLASSIFY_TWEET') {
    getDailyCount().then(count => {
      if (count >= DAILY_LIMIT) {
        sendResponse({ success: false, error: 'DAILY_LIMIT_REACHED' });
        return;
      }
      classifyTweet(request.text, request.apiKey, request.engagement, request.topics)
        .then(async result => {
          await incrementDailyCount();
          sendResponse({ success: true, data: result });
        })
        .catch(err => sendResponse({ success: false, error: err.message }));
    });
    return true; // keep channel open for async
  }

  if (request.type === 'GET_DAILY_COUNT') {
    getDailyCount().then(count => sendResponse({ count, limit: DAILY_LIMIT }));
    return true;
  }

  if (request.type === 'GET_SETTINGS') {
    chrome.storage.local.get([
      'apiKey', 'autoScan', 'paused', 'showSidebar', 'ignoredHandles',
      'marketTopics', 'slackWebhookUrl', 'digestDay', 'minEngagement', 'engagementMetric'
    ], (data) => {
      sendResponse(data);
    });
    return true;
  }

  if (request.type === 'SAVE_SETTINGS') {
    chrome.storage.local.set(request.settings, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'GET_FOUND_TWEETS') {
    chrome.storage.local.get(['foundTweets', 'scannedCount'], (data) => {
      sendResponse({
        foundTweets: data.foundTweets || [],
        scannedCount: data.scannedCount || 0
      });
    });
    return true;
  }

  if (request.type === 'SAVE_FOUND_TWEET') {
    chrome.storage.local.get(['foundTweets', 'scannedCount'], (data) => {
      const tweets = data.foundTweets || [];
      // Avoid duplicates
      if (!tweets.find(t => t.id === request.tweet.id)) {
        tweets.unshift(request.tweet);
        // Keep max 500 tweets
        if (tweets.length > MAX_STORED_TWEETS) tweets.pop();
      }
      chrome.storage.local.set({ foundTweets: tweets }, () => {
        sendResponse({ success: true, count: tweets.length });
      });
    });
    return true;
  }

  if (request.type === 'INCREMENT_SCANNED') {
    chrome.storage.local.get(['scannedCount'], (data) => {
      const count = (data.scannedCount || 0) + 1;
      chrome.storage.local.set({ scannedCount: count }, () => {
        sendResponse({ count });
      });
    });
    return true;
  }

  if (request.type === 'CLEAR_TWEETS') {
    chrome.storage.local.set({ foundTweets: [], scannedCount: 0 }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'DELETE_TWEET') {
    chrome.storage.local.get(['foundTweets'], (data) => {
      const tweets = (data.foundTweets || []).filter(t => t.id !== request.tweetId);
      chrome.storage.local.set({ foundTweets: tweets }, () => {
        sendResponse({ success: true, count: tweets.length });
      });
    });
    return true;
  }

  if (request.type === 'GENERATE_DIGEST') {
    generateDigest(request.apiKey, request.tweets)
      .then(async digest => {
        await saveDigest(digest);
        sendResponse({ success: true, digest });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.type === 'GET_DIGEST_HISTORY') {
    chrome.storage.local.get(['digestHistory'], (data) => {
      sendResponse({ digestHistory: data.digestHistory || [] });
    });
    return true;
  }

  if (request.type === 'SEND_SLACK') {
    sendToSlack(request.webhookUrl, request.markdown)
      .then(async () => {
        // Mark the digest as sent if digestId is provided
        if (request.digestId) {
          const data = await new Promise(resolve => {
            chrome.storage.local.get(['digestHistory'], resolve);
          });
          const history = (data.digestHistory || []).map(d => {
            if (d.id === request.digestId) {
              return { ...d, slackSent: true, slackSentAt: new Date().toISOString() };
            }
            return d;
          });
          chrome.storage.local.set({ digestHistory: history });
        }
        sendResponse({ success: true });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

});

// --- Classification (Claude Haiku) ---

async function classifyTweet(tweetText, apiKey, engagement, topics) {
  const topicList = (topics || []).map(t => `- ${t.id}: ${t.label}`).join('\n');
  const engagementStr = engagement
    ? `Likes: ${engagement.likes || 0}, Retweets: ${engagement.retweets || 0}, Replies: ${engagement.replies || 0}, Bookmarks: ${engagement.bookmarks || 0}, Views: ${engagement.views || 0}`
    : 'No engagement data';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required to call Anthropic directly from the browser. The user's key is
      // stored in Chrome local storage — no server to proxy through.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: `You are a market intelligence tweet classifier for the FF Designer product team.

${PRODUCT_CONTEXT}

Analyze tweets to determine if they are relevant to ANY of the following market topics:

${topicList}

The tweet has the following engagement metrics:
${engagementStr}

Respond ONLY with valid JSON, no other text before or after:
{"is_relevant": true, "topics": ["topic-id-1"], "viralityScore": 7, "hook": "What makes this tweet compelling", "sentiment": "positive", "summary": "One-line summary", "confidence": 0.85, "designerRelevance": "How this relates to FF Designer"}

Rules:
- "is_relevant" should be true only if the tweet genuinely relates to one or more of the listed topics AND is relevant to the FF Designer product space (AI design tools, UI generation, design-to-code, prototyping, design systems, competitor activity, or user pain points FF Designer solves).
- "topics" is an array of matched topic IDs from the list above.
- "viralityScore" is 1-10 based on engagement numbers combined with content quality and shareability.
- "hook" explains what makes this tweet attention-grabbing or compelling.
- "sentiment" is one of: "positive", "negative", "neutral", "mixed".
- "summary" is a concise one-line summary of the tweet's main point.
- "confidence" is 0.0-1.0 indicating how confident you are in the classification.
- "designerRelevance" is a brief note on how this tweet connects to FF Designer's market position, features, or competitive landscape.
- Ignore spam, unrelated content, or tweets with no substantive signal for the FF Designer product space.`,
      messages: [
        {
          role: 'user',
          content: `Classify this tweet:\n\n${sanitizeForJSON(tweetText)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const text = data.content[0].text.trim();

  // Parse JSON — strip backticks and extract first valid JSON object
  let cleaned = text.replace(/```json|```/g, '').trim();

  // Find the first complete JSON object
  const startIdx = cleaned.indexOf('{');
  if (startIdx === -1) throw new Error('No JSON object found in response');

  let braceCount = 0;
  let endIdx = -1;
  for (let i = startIdx; i < cleaned.length; i++) {
    if (cleaned[i] === '{') braceCount++;
    if (cleaned[i] === '}') braceCount--;
    if (braceCount === 0) {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) throw new Error('Incomplete JSON object');

  return JSON.parse(cleaned.slice(startIdx, endIdx + 1));
}

// --- Digest generation (Claude Sonnet) ---

async function generateDigest(apiKey, tweets, previousTrends = null) {
  const now = new Date();
  const weekEnd = now.toISOString().slice(0, 10);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const tweetSummaries = tweets.map((t, i) => {
    const topicNames = (t.topics || []).map(tp => tp.name || tp).join(', ');
    const authorTier = t.authorTier || classifyAuthorTier(t.followers);
    return `${i + 1}. @${t.handle || 'unknown'} [${authorTier}]
   Text: "${(t.text || '').slice(0, 280)}"
   Topics: ${topicNames} | Virality: ${t.viralityScore || 'N/A'} | Sentiment: ${t.sentiment || 'N/A'}
   Likes: ${t.likes || 0} | RTs: ${t.retweets || 0} | Replies: ${t.replies || 0} | Views: ${t.views || 0}
   Hook type: ${t.hook || 'N/A'} | Format: ${t.format || 'text'} | Platform: ${t.platform || 'X'}
   Emotion: ${t.primaryEmotion || 'N/A'}`;
  }).join('\n\n');

  const trendsContext = previousTrends
    ? `\n\nHere are the trending themes from the previous digest for continuity tracking:\n${previousTrends}`
    : '';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: `You are a content strategist and market analyst for FF Designer — an AI-powered UI design tool that generates production-ready designs from natural language prompts.

${PRODUCT_CONTEXT}

Generate a weekly digest in markdown. The digest serves TWO audiences on the same team: strategists who need market context, and content creators who need copy-ready inspiration. Structure it exactly as follows:

---

# STRATEGIC LAYER (skim weekly)

## 1. Market Pulse
Merge market signals and competitive intelligence into ONE concise section. What happened this week in the AI design / vibe design space? Who shipped what? What discourse shifted? Keep to 5–8 bullet points. Focus on what's IN THE CONVERSATION right now so the team stays culturally current. Name competitors explicitly (Figma, Framer, v0, Bolt, Lovable, Galileo AI, etc.) only when they did something notable.

## 2. User Sentiment Snapshot
Surface design-tool frustrations, wishlists, and unmet needs — but prioritize capturing the EXACT LANGUAGE and framing people use. Quote the phrases verbatim (e.g. "I spent 3 hours fighting auto-layout"). Note sentiment direction: is this a growing frustration, a fading complaint, or a new emerging pain? Flag anything FF Designer already solves or could uniquely address.

---

# TACTICAL LAYER (reference when creating content)

## 3. Top Performers Breakdown
Top 5 tweets by virality. For EACH tweet, provide:
- **Tweet**: The full text (or key excerpt)
- **Author**: Handle and tier (founder / influencer / dev / designer / random)
- **Numbers**: Likes, RTs, replies, views
- **Hook pattern**: Categorize the opening — hot take, before/after, demo video, "nobody talks about…", thread, ratio bait, question, controversial claim, tutorial, meme, etc.
- **Emotional lever**: What feeling drove engagement — awe, frustration, FOMO, humor, validation, outrage?
- **Why it worked**: 2–3 sentences on mechanics (timing, controversy, visual proof, relatability, etc.)
- **FF Designer angle**: One concrete way FF Designer could create a response tweet, riff, or parallel piece of content riding this same wave.

## 4. Content Playbook
3–5 specific tweet concepts the FF Designer marketing team could publish THIS WEEK. For each:
- **Draft hook**: An actual opening line they can use or adapt (write it like a real tweet)
- **Format**: text post, screen recording, before/after, carousel, quote tweet, thread, meme
- **Rides on**: Which trending topic or discourse this taps into
- **Emotional lever**: The feeling it targets
- **Why now**: Why this week specifically (tied to something from the data)

Be opinionated and specific. "Post a 12-second screen recording of FF Designer generating a full dashboard from a prompt, hook: 'This is what $0 and a sentence gets you in 2026'" is the level of specificity required. Never write vague advice like "consider showcasing speed."

## 5. Glossary of the Week
3–6 new or trending terms, slang, phrases, or memes that entered the design/dev Twitter vocabulary this week (or gained significant traction). Define each briefly. This helps the team use the right language at the right time.

## 6. Trends Tracker
A persistent section tracking 5–8 theme trajectories across weeks. For each theme:
- **Theme name**
- **Direction**: 📈 Rising, 📊 Peaking, 📉 Fading, 🆕 New this week
- **Evidence**: 1-line summary of what you saw this week

${previousTrends ? 'Use the previous trends data provided to maintain continuity — update directions, graduate or retire themes as needed, and add new ones.' : 'This is the first digest, so establish the initial set of themes based on this week\'s data.'}

---

FORMATTING RULES:
- Use clean markdown with headers, bold, and bullet points.
- Be concise but never vague. Every sentence should be actionable or informative.
- Write the Content Playbook entries as if you're a senior social media strategist pitching to the team, not an analyst writing a report.
- In the Top Performers section, always include the hook pattern and emotional lever — these are the most valuable fields for the content team.`,
      messages: [
        {
          role: 'user',
          content: `Here are ${tweets.length} classified tweets from the week of ${weekStart} to ${weekEnd}:\n\n${tweetSummaries}${trendsContext}\n\nGenerate the weekly market intelligence digest.`
        }
      ]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const markdown = data.content[0].text.trim();

  // Extract the Trends Tracker section for persistence across digests
  const trendsMatch = markdown.match(/## 6\. Trends Tracker\n([\s\S]*?)(?=\n---|\n#|$)/);
  const extractedTrends = trendsMatch ? trendsMatch[1].trim() : null;

  return {
    id: Date.now().toString(),
    generatedAt: new Date().toISOString(),
    weekStart,
    weekEnd,
    tweetCount: tweets.length,
    markdown,
    trends: extractedTrends,
    slackSent: false,
    slackSentAt: null
  };
}

/**
 * Classify author reach tier based on follower count.
 * Used as fallback when tweet data doesn't include a pre-classified tier.
 */
function classifyAuthorTier(followers) {
  if (!followers) return 'unknown';
  if (followers >= 100000) return 'major-influencer';
  if (followers >= 20000) return 'influencer';
  if (followers >= 5000) return 'micro-influencer';
  if (followers >= 1000) return 'creator';
  return 'general';
}

async function saveDigest(digest) {
  return new Promise(resolve => {
    chrome.storage.local.get(['digestHistory'], (data) => {
      const history = data.digestHistory || [];
      history.unshift(digest);
      // Keep max 12 digests
      while (history.length > MAX_DIGESTS) history.pop();
      chrome.storage.local.set({ digestHistory: history }, () => {
        resolve();
      });
    });
  });
}

// --- Slack integration ---

async function sendToSlack(webhookUrl, markdown) {
  // Convert markdown to Slack Block Kit format
  const blocks = markdownToSlackBlocks(markdown);

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Slack webhook error ${response.status}: ${errBody}`);
  }
}

function markdownToSlackBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Top-level header (# or ##) -> header block
    if (/^#{1,2}\s+/.test(trimmed)) {
      // Flush any accumulated section text
      if (currentSection.trim()) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: currentSection.trim() }
        });
        currentSection = '';
      }
      const headerText = trimmed.replace(/^#{1,2}\s+/, '');
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: headerText, emoji: true }
      });
    } else if (/^#{3,}\s+/.test(trimmed)) {
      // Sub-headers (### and below) -> bold text in a new section
      if (currentSection.trim()) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: currentSection.trim() }
        });
        currentSection = '';
      }
      const subHeader = trimmed.replace(/^#{3,}\s+/, '');
      currentSection = `*${subHeader}*\n`;
    } else if (trimmed === '') {
      // Empty line — might signal section break
      if (currentSection.trim()) {
        currentSection += '\n';
      }
    } else {
      // Convert markdown bold **text** to Slack bold *text*
      const slackLine = trimmed.replace(/\*\*(.+?)\*\*/g, '*$1*');
      currentSection += slackLine + '\n';
    }
  }

  // Flush remaining section
  if (currentSection.trim()) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: currentSection.trim() }
    });
  }

  // Slack has a limit of 50 blocks per message
  if (blocks.length > 50) {
    return blocks.slice(0, 50);
  }

  return blocks;
}
