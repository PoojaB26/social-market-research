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
{"is_relevant": true, "topics": ["topic-id-1"], "viralityScore": 7, "hook": "What makes this tweet compelling", "sentiment": "positive", "summary": "One-line summary", "confidence": 0.85, "designerRelevance": "How this relates to FF Designer", "viralityFramework": "engagement_farming|organic|ragebait|clout_chasing|none"}

Rules:
- "is_relevant" should be true only if the tweet genuinely relates to one or more of the listed topics AND is relevant to the FF Designer product space (AI design tools, UI generation, design-to-code, prototyping, design systems, competitor activity, or user pain points FF Designer solves).
- "topics" is an array of matched topic IDs from the list above.
- "viralityScore" is 1-10 based on engagement numbers combined with content quality and shareability.
- "hook" explains what makes this tweet attention-grabbing or compelling.
- "sentiment" is one of: "positive", "negative", "neutral", "mixed".
- "summary" is a concise one-line summary of the tweet's main point.
- "confidence" is 0.0-1.0 indicating how confident you are in the classification.
- "designerRelevance" is a brief note on how this tweet connects to FF Designer's market position, features, or competitive landscape.
- "viralityFramework" identifies the virality tactic used: "engagement_farming" (generic prompts like "what's your hot take?", reply-bait, follow-for-follow), "ragebait" (intentionally inflammatory or misleading to provoke outrage), "clout_chasing" (riding trending topics or tagging big accounts for visibility without adding substance), "organic" (genuine insight, original content, or authentic sharing), or "none" if no clear pattern.
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

  // Score and rank tweets by engagement (likes ×1 + comments ×3 + bookmarks ×2 + retweets ×2 + views ×0.01)
  const scored = tweets.map(t => ({
    ...t,
    engagementScore: (t.likes || 0) + (t.replies || 0) * 3 + (t.bookmarks || 0) * 2 + (t.retweets || 0) * 2 + (t.views || 0) * 0.01
  }));
  scored.sort((a, b) => b.engagementScore - a.engagementScore);

  // Mark top 5
  const top5Ids = new Set(scored.slice(0, 5).map(t => t.id));

  const tweetSummaries = scored.map((t, i) => {
    const topicNames = (t.topics || []).map(tp => tp.name || tp).join(', ');
    const authorTier = t.authorTier || classifyAuthorTier(t.followers);
    const isTop5 = top5Ids.has(t.id) ? ' ⭐ TOP 5' : '';
    return `${i + 1}. @${t.handle || 'unknown'} [${authorTier}]${isTop5}
   Text: "${(t.text || '').slice(0, 280)}"
   Link: ${t.url || 'N/A'}
   Topics: ${topicNames} | Virality: ${t.viralityScore || 'N/A'} | Sentiment: ${t.sentiment || 'N/A'}
   Likes: ${t.likes || 0} | RTs: ${t.retweets || 0} | Replies: ${t.replies || 0} | Bookmarks: ${t.bookmarks || 0} | Views: ${t.views || 0}
   Hook type: ${t.hook || 'N/A'} | Format: ${t.format || 'text'} | Platform: ${t.platform || 'X'}
   Emotion: ${t.primaryEmotion || 'N/A'} | Virality framework: ${t.viralityFramework || 'N/A'}`;
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
      model: 'claude-opus-4-6',
      max_tokens: 4000,
      system: `You are a sharp content strategist for FF Designer — an AI-powered UI design tool.

${PRODUCT_CONTEXT}

Generate a weekly digest in markdown. TOTAL output must be under 2500 words. Scannable, punchy, zero fluff. Optimized for skimming — a reader should get 80% of the value by reading only the bold text.

---

## 1. Market Pulse

5–7 bullets. Each starts with a **bold label**, then 1–2 lines of context. Example:
• **Figma AI** — shipped auto-layout suggestions. Twitter discourse split on quality vs. speed. Designers calling it "half-baked" but PMs love it.
• **v0 pricing** — backlash over new token limits. "priced out" trending among indie devs.

---

## 2. Sentiment

4–5 bullets. Start each with a **quoted user phrase** in bold, then direction and FF Designer relevance. Example:
• **"I spent 3 hours fighting auto-layout"** — growing frustration (3rd week running). FF Designer's prompt-to-layout solves this directly.
• **"Why can't AI just read my Figma file?"** — new emerging pain point. Opportunity for FF Designer import feature.

---

## 3. Top 5 Tweets

The 5 tweets marked with ⭐ TOP 5 are pre-ranked by engagement score (weighted: replies ×3, bookmarks ×2, RTs ×2, likes ×1, views ×0.01). Use these 5 in order. Each tweet as a distinct block separated by a blank line. Format:

**1. @handle** (tier)
> *"Key excerpt of the tweet text"*
• **Link**: url
• **Hook**: type · **Emotion**: type · **Framework**: organic/farming/ragebait/clout
• **Stats**: Xk likes · X RTs · X replies · Xk views
• **Why it hit**: 1–2 sentences on the mechanics — what about the timing, framing, or format made this pop.
• **FF angle**: 1 concrete content idea FF Designer could execute in response.

---

## 4. Content Playbook

3–4 concepts. Each as a distinct block with enough detail to hand directly to a content creator:

**Concept 1**: *format type*
> *"The actual tweet opening line written as a real tweet"*
• **Rides on**: Which trend or discourse from this week
• **Why now**: 1–2 sentences on timing and relevance

---

## 5. Trends

5–8 themes. Each on one line with emoji direction indicator:
• 📈 **Theme name** — 1-line evidence from this week
• 📊 **Theme name** — 1-line evidence
• 📉 **Theme name** — 1-line evidence
• 🆕 **Theme name** — 1-line evidence

${previousTrends ? 'Update from previous trends — retire stale, add new.' : 'Establish initial themes from this week.'}

---

FORMATTING RULES:
• CRITICAL: Use • (bullet character U+2022) for ALL bullet points. NEVER use - or * as bullet markers.
• No intro, no conclusion, no preamble. Start directly with ## 1.
• No tables. Use bullets and bold text for structure.
• Use **bold** liberally for labels and key phrases — this is how readers skim.
• All quoted text (tweet excerpts, hook drafts) MUST use > blockquote with *italics*. Never bold inside a blockquote. Example: > *"This is how it should look"*
• Separate each tweet/concept block with a blank line for breathing room.
• Use · (middle dot) as inline separator instead of | for cleaner reading.
• Prefer fragments over full sentences when meaning is clear.`,
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

  // Extract the Trends section for persistence across digests
  const trendsMatch = markdown.match(/## 5\. Trends\n([\s\S]*?)(?=\n---|\n#|$)/);
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

function extractSlackSections(markdown) {
  // Extract only Top 5 Tweets and Content Playbook for Slack
  const sections = markdown.split(/^## /gm);
  let slackMd = '';

  for (const section of sections) {
    // Match sections 3 and 4 by number prefix
    if (/^[34]\.\s/.test(section.trim())) {
      slackMd += '## ' + section.trim() + '\n\n';
    }
  }

  return slackMd.trim() || markdown;
}

async function sendToSlack(webhookUrl, markdown) {
  // Send only Top 5 + Content Playbook to Slack
  const slackMarkdown = extractSlackSections(markdown);
  const blocks = markdownToSlackBlocks(slackMarkdown);

  // Slack allows max 50 blocks per request — split into batches if needed
  const BATCH_SIZE = 50;
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: JSON.stringify({ blocks: batch })
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Slack webhook error ${response.status}: ${errBody}`);
    }
  }

  // Send each tweet link as its own message using fxtwitter.com for previews
  // X/Twitter blocks Slack unfurls — fxtwitter provides oEmbed that Slack can render
  const tweetUrls = markdown.match(/https?:\/\/(?:x|twitter)\.com\/[^\s)]+\/status\/\d+/g);
  if (tweetUrls) {
    const uniqueUrls = [...new Set(tweetUrls)];
    for (const url of uniqueUrls) {
      const fxUrl = url.replace(/https?:\/\/(x|twitter)\.com/, 'https://fxtwitter.com');
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: JSON.stringify({ text: fxUrl, unfurl_links: true, unfurl_media: true })
      });
      // Wait 1s between messages to let Slack process unfurls
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function markdownToSlackBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');
  let currentSection = '';

  // Slack section text limit is 3000 chars
  const SECTION_LIMIT = 2900;

  function flushSection() {
    const text = currentSection.trim();
    if (!text) return;
    // Split into chunks if exceeding Slack's 3000 char limit
    if (text.length <= SECTION_LIMIT) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    } else {
      // Split on double newlines first, then single newlines
      const paragraphs = text.split(/\n\n/);
      let chunk = '';
      for (const para of paragraphs) {
        if (chunk.length + para.length + 2 > SECTION_LIMIT) {
          if (chunk.trim()) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk.trim() } });
          }
          chunk = para;
        } else {
          chunk += (chunk ? '\n\n' : '') + para;
        }
      }
      if (chunk.trim()) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk.trim() } });
      }
    }
    currentSection = '';
  }

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Detect markdown table: line with pipes followed by separator row
    if (trimmed.includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+[-|\s:]+$/.test(lines[i + 1].trim())) {
      flushSection();
      // Collect all table rows as monospace block
      const tableLines = [lines[i].trim()];
      i++; // skip separator
      i++;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        tableLines.push(lines[i].trim());
        i++;
      }
      // Render as code block in Slack (best table approximation)
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '```\n' + tableLines.join('\n') + '\n```' }
      });
      continue;
    }

    // Horizontal rules -> divider block
    if (/^-{3,}$/.test(trimmed)) {
      flushSection();
      blocks.push({ type: 'divider' });
    // Top-level header (# or ##) -> header block
    } else if (/^#{1,2}\s+/.test(trimmed)) {
      flushSection();
      const headerText = trimmed.replace(/^#{1,2}\s+/, '');
      blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: headerText, emoji: true }
      });
    } else if (/^#{3,}\s+/.test(trimmed)) {
      // Sub-headers (### and below) -> bold text in a new section
      flushSection();
      const subHeader = trimmed.replace(/^#{3,}\s+/, '');
      currentSection = `*${subHeader}*\n`;
    } else if (trimmed === '') {
      if (currentSection.trim()) {
        currentSection += '\n';
      }
    } else {
      // Convert markdown bold **text** to Slack bold *text*
      let slackLine = trimmed.replace(/\*\*(.+?)\*\*/g, '*$1*');
      // Convert markdown dash bullets to • for Slack
      slackLine = slackLine.replace(/^- /, '• ');
      // Wrap @handles in inline code
      slackLine = slackLine.replace(/@(\w{1,15})\b/g, '`@$1`');
      // Convert markdown blockquotes (> text) to Slack blockquotes
      // Strip any bold inside blockquotes — quotes should be italic only
      if (slackLine.startsWith('> ')) {
        slackLine = '> ' + slackLine.slice(2).replace(/\*([^*]+)\*/g, (_, inner) => {
          // Preserve italic (single *) but remove bold (was ** before conversion)
          return '_' + inner + '_';
        });
      }
      currentSection += slackLine + '\n';
    }
    i++;
  }

  flushSection();
  return blocks;
}
