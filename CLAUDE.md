# CLAUDE.md

## Project Overview

Tweet Market Intel is a Chrome Extension that scans X/Twitter feeds, classifies tweets about configurable market topics using Claude Haiku, scores virality, generates weekly analytics digests with Claude Sonnet, and posts them to Slack. All analysis is framed through the lens of the FF Designer product — an AI-powered design tool. The `PRODUCT_CONTEXT` constant in background.js contains the product description used in classification and digest prompts.

## Architecture

Single component — the Chrome Extension (root directory):

- **Content script** (`js/content.js`) — injected on x.com/twitter.com home feed and search pages. Creates the sidebar UI (3 tabs: Feed, Analytics, Trends), observes feed via MutationObserver, extracts engagement metrics from DOM, filters and queues tweets for classification, handles search/export/digest/Slack.
- **Background service worker** (`js/background.js`) — handles all message routing, Anthropic API calls (Haiku for classification, Sonnet for digests), Chrome storage reads/writes, Slack webhook POSTs, weekly digest alarm.
- **Popup** (`popup.html` + `js/popup.js`) — settings: API key, toggles, market topics (chip input with color), Slack webhook URL, digest day, engagement threshold, ignored handles.

### Data Flow

- Content script extracts tweets from DOM (home/search pages only) + engagement metrics (likes, retweets, replies, bookmarks, views) → dedupes, filters short tweets, ignored handles, and below-threshold engagement → queues survivors
- Background script calls Anthropic API with Claude Haiku → returns classification with topic matching, virality score, hook, sentiment
- Classified tweets stored in Chrome local storage (max 500)
- Weekly digest: background alarm triggers Claude Sonnet to synthesize past 7 days of tweets → stores digest (max 12) → optionally POSTs to Slack

### Chrome Extension Message Types

`CLASSIFY_TWEET`, `GET_SETTINGS`, `SAVE_SETTINGS`, `SETTINGS_UPDATED`, `GET_FOUND_TWEETS`, `SAVE_FOUND_TWEET`, `INCREMENT_SCANNED`, `GET_DAILY_COUNT`, `CLEAR_TWEETS`, `DELETE_TWEET`, `GENERATE_DIGEST`, `GET_DIGEST_HISTORY`, `SEND_SLACK`

## Build Commands

No build step — plain JS. Load unpacked at `chrome://extensions/` pointing to the repo root.

## Key Constants

- **Daily API limit**: 1000 tweets per day (tracked in Chrome storage by date key)
- **Max concurrent API calls**: 2
- **Max stored tweets**: 500 (in Chrome storage)
- **Max stored digests**: 12
- **Classification model**: `claude-haiku-4-5-20251001`
- **Digest model**: `claude-sonnet-4-6`
- **Tweet min length**: 50 chars (shorter tweets skipped)
- **Confidence threshold**: 0.6 (below this, tweets are discarded)
- **CSS prefix**: `tmi-` (to avoid conflicts with sibling extension Tweet Tool Finder which uses `ttf-`)

## Extension Structure

- `manifest.json` — Manifest V3, content script runs on x.com/twitter.com at `document_idle`, has `alarms` permission
- `js/content.js` — IIFE that creates 3-tab sidebar UI, observes feed, extracts engagement metrics, queues tweets for classification, renders analytics/trends
- `js/background.js` — Service worker handling message routing, Anthropic API calls, Slack webhooks, weekly digest alarm
- `js/popup.js` — Settings popup logic (API key, market topics, Slack, toggles, ignored handles)
- `css/sidebar.css` — Sidebar styling; all classes prefixed with `tmi-` to avoid conflicts
- `popup.html` — Settings popup with inline styles

## Storage Schema

- **Settings**: apiKey, autoScan, paused, showSidebar, ignoredHandles, marketTopics[{id, label, color}], slackWebhookUrl, digestDay (0-6), minEngagement, engagementMetric
- **Tweets**: foundTweets[] (max 500) with engagement metrics, topics, viralityScore, hook, sentiment, summary
- **Digests**: digestHistory[] (max 12) with generatedAt, markdown, slackSent status
- **Rate limit**: dailyCount_YYYY-MM-DD, lastDigestRun
