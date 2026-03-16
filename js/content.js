// content.js — Scans X/Twitter feed and collects market intelligence tweets

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────
  let settings = { apiKey: '', autoScan: true, showSidebar: true, ignoredHandles: [], marketTopics: [], slackWebhookUrl: '', digestDay: 1, minEngagement: 100, engagementMetric: 'likes' };
  let processedTweetIds = new Set();
  let foundTweets = [];
  let isScanning = false;
  let isPaused = false;
  let scanQueue = [];
  let activeTab = 'feed'; // 'feed', 'analytics', 'trends'
  let searchQuery = '';
  let sidebarOpen = false;
  let activeCalls = 0;
  let dailyCount = 0;
  const MAX_CONCURRENT = 2;
  const DAILY_LIMIT = 1000;
  let limitReached = false;
  let digestHistory = [];

  // ── Initialize ─────────────────────────────────────────
  init();

  async function init() {
    // Load settings
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (data) => {
      if (data) {
        settings = { ...settings, ...data };
        isPaused = !!data.paused;
      }
      // Load previously found tweets
      chrome.runtime.sendMessage({ type: 'GET_FOUND_TWEETS' }, (resp) => {
        foundTweets = resp.foundTweets || [];
        // Mark already-processed tweets
        foundTweets.forEach(t => processedTweetIds.add(t.id));
        // Load daily count
        chrome.runtime.sendMessage({ type: 'GET_DAILY_COUNT' }, (dcResp) => {
          dailyCount = dcResp?.count || 0;
          limitReached = dailyCount >= DAILY_LIMIT;
          // Load digest history
          chrome.runtime.sendMessage({ type: 'GET_DIGEST_HISTORY' }, (dhResp) => {
            digestHistory = dhResp?.digestHistory || [];
            createUI();
            if (settings.autoScan && settings.apiKey && !limitReached) {
              startObserving();
            }
          });
        });
      });
    });
  }

  // ── Listen for settings updates from popup ─────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_UPDATED') {
      const wasPaused = isPaused;
      settings = { ...settings, ...msg.settings };
      isPaused = !!msg.settings.paused;

      if (isPaused && !wasPaused) {
        scanQueue = [];
        updateScanStatus('Paused', false);
      } else if (!isPaused && wasPaused) {
        updateScanStatus('Resumed. Watching feed...', true);
        scanVisibleTweets();
      }

      if (settings.autoScan && settings.apiKey && !isPaused) {
        startObserving();
      }
      updateSidebarVisibility();
    }
  });

  // ── Inject Styles ────────────────────────────────────────
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=DM+Sans:wght@400;500;600&display=swap');

      #tmi-sidebar {
        position: fixed;
        top: 0;
        left: 0;
        width: 420px;
        height: 100vh;
        background: #0d0d0f;
        border-right: 1px solid rgba(255,255,255,0.06);
        z-index: 99999;
        font-family: 'DM Sans', sans-serif;
        color: #e8e6e3;
        display: flex;
        flex-direction: column;
        transform: translateX(-100%);
        transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 8px 0 32px rgba(0,0,0,0.5);
      }

      #tmi-sidebar.tmi-open {
        transform: translateX(0);
      }

      /* Toggle button */
      #tmi-toggle-btn {
        position: fixed;
        left: 16px;
        bottom: 24px;
        width: 52px;
        height: 52px;
        border-radius: 16px;
        background: linear-gradient(135deg, #4e8cff, #2563eb);
        border: none;
        cursor: pointer;
        z-index: 99998;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 20px rgba(37, 99, 235, 0.3);
        transition: transform 0.2s, box-shadow 0.2s;
        font-size: 22px;
      }

      #tmi-toggle-btn:hover {
        transform: scale(1.08);
        box-shadow: 0 6px 28px rgba(37, 99, 235, 0.45);
      }

      #tmi-toggle-btn .tmi-badge {
        position: absolute;
        top: -4px;
        left: -4px;
        min-width: 20px;
        height: 20px;
        background: #ff3b5c;
        border-radius: 10px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 700;
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 5px;
      }

      /* Sidebar Header */
      .tmi-header {
        padding: 20px 20px 16px;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border-bottom: 1px solid rgba(255,255,255,0.06);
        flex-shrink: 0;
      }

      .tmi-header-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .tmi-header h2 {
        font-family: 'JetBrains Mono', monospace;
        font-size: 15px;
        font-weight: 700;
        color: #4e8cff;
        letter-spacing: -0.3px;
        margin: 0;
      }

      .tmi-close-btn {
        width: 30px;
        height: 30px;
        border-radius: 8px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        color: #6a6a7a;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        transition: background 0.2s;
      }

      .tmi-close-btn:hover {
        background: rgba(255,255,255,0.1);
        color: #e8e6e3;
      }

      /* Tab buttons */
      .tmi-tabs {
        display: flex;
        gap: 6px;
        margin-top: 14px;
      }

      .tmi-tab {
        padding: 6px 14px;
        border-radius: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 600;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.06);
        color: #6a6a7a;
        cursor: pointer;
        transition: all 0.2s;
      }

      .tmi-tab:hover {
        background: rgba(255,255,255,0.08);
        color: #c0c0cc;
      }

      .tmi-tab.active {
        background: rgba(78, 140, 255, 0.12);
        border-color: rgba(78, 140, 255, 0.3);
        color: #4e8cff;
      }

      /* Search input */
      .tmi-search {
        width: 100%;
        margin-top: 10px;
        padding: 7px 10px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px;
        color: #e8e6e3;
        font-family: 'DM Sans', sans-serif;
        font-size: 12px;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.2s;
      }

      .tmi-search::placeholder {
        color: #4a4a5a;
      }

      .tmi-search:focus {
        border-color: rgba(78, 140, 255, 0.35);
      }

      /* Scanning status */
      .tmi-scan-status {
        padding: 10px 20px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: #6a6a7a;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }

      .tmi-scan-status .tmi-pulse {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #4e8cff;
        animation: tmi-pulse 2s ease-in-out infinite;
      }

      @keyframes tmi-pulse {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 1; }
      }

      .tmi-scan-status.idle .tmi-pulse {
        background: #6a6a7a;
        animation: none;
      }

      /* Content area */
      .tmi-content {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
      }

      .tmi-content::-webkit-scrollbar {
        width: 4px;
      }

      .tmi-content::-webkit-scrollbar-track {
        background: transparent;
      }

      .tmi-content::-webkit-scrollbar-thumb {
        background: #2a2a3e;
        border-radius: 4px;
      }

      /* Tab panels */
      .tmi-tab-panel {
        display: none;
        flex: 1;
        flex-direction: column;
        overflow-y: auto;
        padding: 12px;
      }

      .tmi-tab-panel.active {
        display: flex;
      }

      .tmi-tab-panel::-webkit-scrollbar {
        width: 4px;
      }

      .tmi-tab-panel::-webkit-scrollbar-track {
        background: transparent;
      }

      .tmi-tab-panel::-webkit-scrollbar-thumb {
        background: #2a2a3e;
        border-radius: 4px;
      }

      /* Feed cards */
      .tmi-cards {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .tmi-card {
        background: #13131a;
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 12px;
        padding: 16px;
        transition: border-color 0.2s, transform 0.15s;
        cursor: pointer;
        animation: tmi-slideIn 0.3s ease-out;
      }

      @keyframes tmi-slideIn {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .tmi-card:hover {
        border-color: rgba(78, 140, 255, 0.25);
        transform: translateY(-1px);
      }

      .tmi-card-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
      }

      .tmi-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: #2a2a3e;
        object-fit: cover;
      }

      .tmi-author {
        font-size: 13px;
        font-weight: 600;
        color: #e8e6e3;
      }

      .tmi-handle {
        font-size: 12px;
        color: #5a5a6a;
      }

      .tmi-card-summary {
        font-size: 13px;
        font-weight: 500;
        line-height: 1.5;
        color: #e8e6e3;
        margin-bottom: 8px;
        padding: 8px 10px;
        background: rgba(78, 140, 255, 0.05);
        border-left: 2px solid #4e8cff;
        border-radius: 0 6px 6px 0;
      }

      .tmi-card-relevance {
        font-size: 11px;
        line-height: 1.5;
        color: #8a8a9a;
        margin-bottom: 8px;
        padding: 6px 10px;
        background: rgba(255, 184, 0, 0.05);
        border-left: 2px solid #ffb800;
        border-radius: 0 6px 6px 0;
        font-family: 'JetBrains Mono', monospace;
      }

      .tmi-open-icon {
        font-size: 16px;
        color: #4a4a5a;
        transition: color 0.2s;
        flex-shrink: 0;
      }

      .tmi-card:hover .tmi-open-icon {
        color: #4e8cff;
      }

      .tmi-delete-btn {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        background: transparent;
        border: 1px solid transparent;
        color: #4a4a5a;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        flex-shrink: 0;
        transition: all 0.2s;
        opacity: 0;
      }

      .tmi-card:hover .tmi-delete-btn {
        opacity: 1;
      }

      .tmi-delete-btn:hover {
        background: rgba(255, 59, 92, 0.12);
        border-color: rgba(255, 59, 92, 0.25);
        color: #ff3b5c;
      }

      /* Engagement metrics row */
      .tmi-engagement {
        display: flex;
        gap: 12px;
        margin-bottom: 8px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        color: #6a6a7a;
      }

      .tmi-engagement span {
        display: flex;
        align-items: center;
        gap: 3px;
      }

      /* Topic tags */
      .tmi-card-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
      }

      .tmi-tag {
        padding: 3px 9px;
        border-radius: 4px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      /* Virality score bar */
      .tmi-virality {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 4px;
      }

      .tmi-virality-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        color: #6a6a7a;
        white-space: nowrap;
      }

      .tmi-virality-track {
        flex: 1;
        height: 4px;
        background: rgba(255,255,255,0.06);
        border-radius: 2px;
        overflow: hidden;
      }

      .tmi-virality-bar {
        height: 100%;
        border-radius: 2px;
        transition: width 0.3s ease;
      }

      .tmi-virality-score {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        font-weight: 700;
        min-width: 18px;
        text-align: right;
      }

      /* Empty state */
      .tmi-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 60px 30px;
        text-align: center;
      }

      .tmi-empty-icon {
        font-size: 40px;
        margin-bottom: 16px;
        opacity: 0.6;
      }

      .tmi-empty h3 {
        font-family: 'JetBrains Mono', monospace;
        font-size: 14px;
        color: #6a6a7a;
        margin-bottom: 6px;
      }

      .tmi-empty p {
        font-size: 12px;
        color: #4a4a5a;
        line-height: 1.5;
      }

      /* Footer */
      .tmi-footer {
        padding: 12px 14px;
        border-top: 1px solid rgba(255,255,255,0.04);
        display: flex;
        gap: 8px;
        align-items: center;
        flex-shrink: 0;
      }

      .tmi-footer button {
        padding: 7px 12px;
        border-radius: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
        color: #6a6a7a;
        white-space: nowrap;
      }

      .tmi-footer button:hover {
        background: rgba(255,255,255,0.08);
        color: #c0c0cc;
      }

      .tmi-footer .tmi-copy-btn {
        flex: 1;
        background: rgba(78, 140, 255, 0.12);
        border-color: rgba(78, 140, 255, 0.25);
        color: #4e8cff;
      }

      .tmi-footer .tmi-copy-btn:hover {
        background: rgba(78, 140, 255, 0.22);
      }

      .tmi-footer .tmi-export-btn {
        background: rgba(108, 99, 255, 0.1);
        border-color: rgba(108, 99, 255, 0.2);
        color: #8b83ff;
      }

      .tmi-footer .tmi-export-btn:hover {
        background: rgba(108, 99, 255, 0.2);
      }

      /* Analytics panel */
      .tmi-analytics-panel {
        gap: 12px;
      }

      .tmi-generate-btn {
        width: 100%;
        padding: 10px 16px;
        border-radius: 8px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid rgba(78, 140, 255, 0.3);
        background: rgba(78, 140, 255, 0.12);
        color: #4e8cff;
        transition: all 0.2s;
      }

      .tmi-generate-btn:hover {
        background: rgba(78, 140, 255, 0.22);
      }

      .tmi-generate-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .tmi-slack-btn {
        width: 100%;
        padding: 8px 14px;
        border-radius: 8px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid rgba(74, 194, 107, 0.3);
        background: rgba(74, 194, 107, 0.12);
        color: #4ac26b;
        transition: all 0.2s;
        margin-top: 8px;
      }

      .tmi-slack-btn:hover {
        background: rgba(74, 194, 107, 0.22);
      }

      .tmi-digest-display {
        background: #13131a;
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 10px;
        padding: 16px;
        font-size: 13px;
        line-height: 1.6;
        color: #c0c0cc;
      }

      .tmi-digest-display h1,
      .tmi-digest-display h2,
      .tmi-digest-display h3 {
        font-family: 'JetBrains Mono', monospace;
        color: #e8e6e3;
        margin: 12px 0 6px 0;
      }

      .tmi-digest-display h1 { font-size: 16px; }
      .tmi-digest-display h2 { font-size: 14px; }
      .tmi-digest-display h3 { font-size: 13px; }

      .tmi-digest-display strong {
        color: #e8e6e3;
      }

      .tmi-digest-display em {
        color: #8b83ff;
      }

      .tmi-digest-display ul, .tmi-digest-display ol {
        padding-left: 20px;
        margin: 6px 0;
      }

      .tmi-digest-display li {
        margin: 4px 0;
      }

      .tmi-digest-display hr {
        border: none;
        border-top: 1px solid rgba(255,255,255,0.08);
        margin: 12px 0;
      }

      .tmi-digest-display blockquote {
        border-left: 3px solid #4e8cff;
        margin: 8px 0;
        padding: 6px 12px;
        background: rgba(78, 140, 255, 0.06);
        border-radius: 0 6px 6px 0;
        color: #b0b0c0;
        font-style: italic;
      }

      .tmi-digest-display code {
        background: rgba(255,255,255,0.08);
        padding: 1px 5px;
        border-radius: 3px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.9em;
        color: #7eb8ff;
      }

      .tmi-digest-display .tmi-table {
        width: 100%;
        border-collapse: collapse;
        margin: 10px 0;
        font-size: 11px;
      }

      .tmi-digest-display .tmi-table th,
      .tmi-digest-display .tmi-table td {
        padding: 6px 10px;
        text-align: left;
        border: 1px solid rgba(255,255,255,0.08);
      }

      .tmi-digest-display .tmi-table th {
        background: rgba(255,255,255,0.05);
        font-weight: 600;
        color: #b0b0c0;
        font-family: 'JetBrains Mono', monospace;
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.5px;
      }

      .tmi-digest-display .tmi-table td {
        color: #9a9aaa;
      }

      .tmi-digest-display .tmi-table tr:hover td {
        background: rgba(255,255,255,0.03);
      }

      .tmi-digest-history {
        margin-top: 12px;
      }

      .tmi-digest-history-title {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 600;
        color: #6a6a7a;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
      }

      .tmi-digest-item {
        padding: 8px 12px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.2s;
        margin-bottom: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: #8a8a9a;
      }

      .tmi-digest-item:hover {
        background: rgba(78, 140, 255, 0.08);
        border-color: rgba(78, 140, 255, 0.2);
        color: #c0c0cc;
      }

      /* Trends panel */
      .tmi-trends-panel {
        gap: 8px;
      }

      .tmi-trends-title {
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        font-weight: 700;
        color: #e8e6e3;
        margin-bottom: 4px;
      }

      .tmi-chart-bar-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }

      .tmi-chart-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: #8a8a9a;
        min-width: 100px;
        text-align: right;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tmi-chart-bar-track {
        flex: 1;
        height: 16px;
        background: rgba(255,255,255,0.04);
        border-radius: 4px;
        overflow: hidden;
      }

      .tmi-chart-bar {
        height: 100%;
        border-radius: 4px;
        transition: width 0.4s ease;
        min-width: 2px;
      }

      .tmi-chart-count {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 700;
        color: #c0c0cc;
        min-width: 28px;
        text-align: left;
      }

      .tmi-trends-summary {
        margin-top: 12px;
        padding: 12px;
        background: #13131a;
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 8px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: #6a6a7a;
        line-height: 1.7;
      }

      .tmi-trends-summary strong {
        color: #c0c0cc;
      }
    `;
    document.head.appendChild(style);
  }

  // ── UI Creation ────────────────────────────────────────
  function createUI() {
    injectStyles();

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'tmi-toggle-btn';
    toggleBtn.innerHTML = `\u{1F4CA}<span class="tmi-badge" style="display:none">0</span>`;
    toggleBtn.addEventListener('click', toggleSidebar);
    document.body.appendChild(toggleBtn);

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.id = 'tmi-sidebar';
    sidebar.innerHTML = `
      <div class="tmi-header">
        <div class="tmi-header-top">
          <h2>\u{1F4CA} Market Intel</h2>
          <button class="tmi-close-btn" id="tmi-close">\u2715</button>
        </div>
        <div class="tmi-tabs">
          <button class="tmi-tab active" data-tab="feed">Feed</button>
          <button class="tmi-tab" data-tab="analytics">Analytics</button>
          <button class="tmi-tab" data-tab="trends">Trends</button>
        </div>
        <input class="tmi-search" id="tmi-search" type="text" placeholder="Search saved tweets..." autocomplete="off" />
      </div>
      <div class="tmi-scan-status" id="tmi-scan-status">
        <span class="tmi-pulse"></span>
        <span id="tmi-status-text">Waiting to scan...</span>
        <span id="tmi-daily-counter" style="margin-left:auto;color:#6a6a7a;font-size:10px;">0 / ${DAILY_LIMIT} today</span>
      </div>
      <div class="tmi-content" id="tmi-content">
        <div class="tmi-tab-panel active" id="tmi-feed-panel">
          <div class="tmi-cards" id="tmi-cards">
            <div class="tmi-empty">
              <div class="tmi-empty-icon">\u{1F50D}</div>
              <h3>No market intel yet</h3>
              <p>Scroll through your feed and I'll catch tweets with market intelligence.</p>
            </div>
          </div>
        </div>
        <div class="tmi-tab-panel" id="tmi-analytics-panel">
          <button class="tmi-generate-btn" id="tmi-generate-digest">\u{1F4CB} Generate Report</button>
          <div id="tmi-digest-area"></div>
          <div id="tmi-digest-history-area"></div>
        </div>
        <div class="tmi-tab-panel" id="tmi-trends-panel">
          <div id="tmi-trends-chart"></div>
        </div>
      </div>
      <div class="tmi-footer">
        <button class="tmi-clear-btn" id="tmi-clear">Clear</button>
        <button class="tmi-export-btn" id="tmi-export">\u2B07 JSON</button>
        <button class="tmi-copy-btn" id="tmi-copy">\u{1F4CB} Copy</button>
      </div>
    `;
    document.body.appendChild(sidebar);

    // Event listeners
    document.getElementById('tmi-close').addEventListener('click', toggleSidebar);
    document.getElementById('tmi-clear').addEventListener('click', clearAll);
    document.getElementById('tmi-copy').addEventListener('click', copyContext);
    document.getElementById('tmi-export').addEventListener('click', exportContext);
    document.getElementById('tmi-generate-digest').addEventListener('click', generateDigest);
    document.getElementById('tmi-search').addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      renderCards();
    });

    sidebar.querySelectorAll('.tmi-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        sidebar.querySelectorAll('.tmi-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        switchTab();
      });
    });

    // Initial render
    switchTab();
    updateBadge();
    updateSidebarVisibility();
  }

  function switchTab() {
    const feedPanel = document.getElementById('tmi-feed-panel');
    const analyticsPanel = document.getElementById('tmi-analytics-panel');
    const trendsPanel = document.getElementById('tmi-trends-panel');
    const searchInput = document.getElementById('tmi-search');

    if (!feedPanel || !analyticsPanel || !trendsPanel) return;

    feedPanel.classList.toggle('active', activeTab === 'feed');
    analyticsPanel.classList.toggle('active', activeTab === 'analytics');
    trendsPanel.classList.toggle('active', activeTab === 'trends');

    // Search only visible on Feed tab
    if (searchInput) {
      searchInput.style.display = activeTab === 'feed' ? 'block' : 'none';
    }

    if (activeTab === 'feed') {
      renderCards();
    } else if (activeTab === 'analytics') {
      renderAnalytics();
    } else if (activeTab === 'trends') {
      renderTrendsChart();
    }
  }

  function toggleSidebar() {
    const sidebar = document.getElementById('tmi-sidebar');
    sidebarOpen = !sidebarOpen;
    sidebar.classList.toggle('tmi-open', sidebarOpen);
  }

  function updateSidebarVisibility() {
    const toggleBtn = document.getElementById('tmi-toggle-btn');
    if (toggleBtn) {
      toggleBtn.style.display = settings.showSidebar ? 'flex' : 'none';
    }
  }

  function updateBadge() {
    const badge = document.querySelector('#tmi-toggle-btn .tmi-badge');
    if (!badge) return;
    const count = foundTweets.length;
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }

  function updateScanStatus(text, scanning) {
    const statusEl = document.getElementById('tmi-scan-status');
    const textEl = document.getElementById('tmi-status-text');
    const counterEl = document.getElementById('tmi-daily-counter');
    if (!statusEl || !textEl) return;
    textEl.textContent = text;
    statusEl.classList.toggle('idle', !scanning);
    if (counterEl) {
      counterEl.textContent = `${dailyCount} / ${DAILY_LIMIT} today`;
      counterEl.style.color = dailyCount >= DAILY_LIMIT * 0.9 ? '#ff3b5c' : '#6a6a7a';
    }
  }

  // ── Render Feed Cards ────────────────────────────────────
  function renderCards() {
    const container = document.getElementById('tmi-cards');
    if (!container) return;

    let filtered = [...foundTweets];

    if (searchQuery) {
      filtered = filtered.filter(t => {
        const haystack = [t.summary, t.text, t.author, t.handle, t.hook, t.sentiment, t.designerRelevance]
          .concat((t.topics || []).map(tp => tp.name || tp))
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(searchQuery);
      });
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="tmi-empty">
          <div class="tmi-empty-icon">\u{1F50D}</div>
          <h3>No market intel yet</h3>
          <p>Scroll through your feed and I'll catch tweets with market intelligence.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(tweet => {
      const topicTags = (tweet.topics || []).map(tp => {
        const name = tp.name || tp;
        const color = tp.color || '#4e8cff';
        return `<span class="tmi-tag" style="background:${hexToRgba(color, 0.1)};color:${color};border:1px solid ${hexToRgba(color, 0.2)}">${escapeHtml(name)}</span>`;
      }).join('');

      const viralityScore = tweet.viralityScore || 0;
      const viralityColor = viralityScore >= 7 ? '#00e5a0' : viralityScore >= 4 ? '#ffb800' : '#ff3b5c';
      const viralityWidth = Math.max(viralityScore * 10, 2);

      return `
      <div class="tmi-card" data-url="${tweet.url}" data-id="${tweet.id}">
        <div class="tmi-card-header">
          ${tweet.avatar ? `<img class="tmi-avatar" src="${tweet.avatar}" alt="" />` : '<div class="tmi-avatar"></div>'}
          <div style="flex:1;min-width:0">
            <div class="tmi-author">${escapeHtml(tweet.author)}</div>
            <div class="tmi-handle">${escapeHtml(tweet.handle)}</div>
          </div>
          <button class="tmi-delete-btn" data-id="${tweet.id}" title="Remove">\u2715</button>
          <span class="tmi-open-icon" title="Open tweet on X">\u2197</span>
        </div>
        ${tweet.summary ? `<div class="tmi-card-summary">\u{1F4A1} ${escapeHtml(tweet.summary)}</div>` : ''}
        ${tweet.designerRelevance ? `<div class="tmi-card-relevance">\u{1F3AF} ${escapeHtml(tweet.designerRelevance)}</div>` : ''}
        ${tweet.viralityFramework && tweet.viralityFramework !== 'none' && tweet.viralityFramework !== 'organic' ? `<div class="tmi-card-framework">\u26A0\uFE0F ${escapeHtml(tweet.viralityFramework.replace(/_/g, ' '))}</div>` : ''}
        <div class="tmi-engagement">
          <span>\u2764\uFE0F ${formatNumber(tweet.likes || 0)}</span>
          <span>\u{1F501} ${formatNumber(tweet.retweets || 0)}</span>
          <span>\u{1F4AC} ${formatNumber(tweet.replies || 0)}</span>
          <span>\u{1F441} ${formatNumber(tweet.views || 0)}</span>
        </div>
        ${topicTags ? `<div class="tmi-card-tags">${topicTags}</div>` : ''}
        <div class="tmi-virality">
          <span class="tmi-virality-label">Virality</span>
          <div class="tmi-virality-track">
            <div class="tmi-virality-bar" style="width:${viralityWidth}%;background:${viralityColor}"></div>
          </div>
          <span class="tmi-virality-score" style="color:${viralityColor}">${viralityScore}</span>
        </div>
      </div>
    `}).join('');

    // Attach click handlers for opening tweets
    container.querySelectorAll('.tmi-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.tmi-delete-btn')) return;
        const url = card.getAttribute('data-url');
        if (url) window.open(url, '_blank');
      });
    });

    // Attach delete handlers
    container.querySelectorAll('.tmi-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        removeTweet(id);
      });
    });
  }

  // ── Render Analytics Panel ────────────────────────────────
  function renderAnalytics() {
    const digestArea = document.getElementById('tmi-digest-area');
    const historyArea = document.getElementById('tmi-digest-history-area');
    if (!digestArea || !historyArea) return;

    // Show latest digest if available
    if (digestHistory.length > 0) {
      const latest = digestHistory[0];
      digestArea.innerHTML = `
        <div class="tmi-digest-display">${markdownToHtml(latest.markdown)}</div>
        ${settings.slackWebhookUrl ? `<button class="tmi-slack-btn" id="tmi-send-slack">\u{1F4E4} Send to Slack</button>` : ''}
      `;
      const slackBtn = document.getElementById('tmi-send-slack');
      if (slackBtn) {
        slackBtn.addEventListener('click', () => sendToSlack(latest.markdown));
      }
    } else {
      digestArea.innerHTML = '';
    }

    // Digest history list
    if (digestHistory.length > 1) {
      historyArea.innerHTML = `
        <div class="tmi-digest-history">
          <div class="tmi-digest-history-title">Past Reports</div>
          ${digestHistory.map((d, i) => `
            <div class="tmi-digest-item" data-index="${i}">
              ${escapeHtml(d.weekStart || d.generatedAt?.slice(0, 10) || 'Report')} \u2014 ${d.tweetCount || 0} tweets
            </div>
          `).join('')}
        </div>
      `;
      historyArea.querySelectorAll('.tmi-digest-item').forEach(item => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.dataset.index);
          const digest = digestHistory[idx];
          if (digest) {
            digestArea.innerHTML = `
              <div class="tmi-digest-display">${markdownToHtml(digest.markdown)}</div>
              ${settings.slackWebhookUrl ? `<button class="tmi-slack-btn" id="tmi-send-slack">\u{1F4E4} Send to Slack</button>` : ''}
            `;
            const slackBtn = document.getElementById('tmi-send-slack');
            if (slackBtn) {
              slackBtn.addEventListener('click', () => sendToSlack(digest.markdown));
            }
          }
        });
      });
    } else {
      historyArea.innerHTML = '';
    }
  }

  // ── Render Trends Chart ───────────────────────────────────
  function renderTrendsChart() {
    const container = document.getElementById('tmi-trends-chart');
    if (!container) return;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentTweets = foundTweets.filter(t => {
      const d = t.foundAt ? new Date(t.foundAt) : null;
      return d && d >= sevenDaysAgo;
    });

    // Count per topic
    const topicCounts = {};
    const topicColors = {};
    recentTweets.forEach(t => {
      (t.topics || []).forEach(tp => {
        const name = tp.name || tp;
        const color = tp.color || '#4e8cff';
        topicCounts[name] = (topicCounts[name] || 0) + 1;
        topicColors[name] = color;
      });
    });

    const entries = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
    const maxCount = entries.length > 0 ? Math.max(...entries.map(e => e[1])) : 1;

    // Average virality
    const viralityScores = recentTweets.map(t => t.viralityScore || 0).filter(v => v > 0);
    const avgVirality = viralityScores.length > 0
      ? (viralityScores.reduce((a, b) => a + b, 0) / viralityScores.length).toFixed(1)
      : '0.0';

    if (entries.length === 0) {
      container.innerHTML = `
        <div class="tmi-empty">
          <div class="tmi-empty-icon">\u{1F4C8}</div>
          <h3>No trend data yet</h3>
          <p>Collect some tweets and trends will appear here.</p>
        </div>
      `;
      return;
    }

    const barsHtml = entries.map(([name, count]) => {
      const pct = (count / maxCount) * 100;
      const color = topicColors[name] || '#4e8cff';
      return `
        <div class="tmi-chart-bar-row">
          <span class="tmi-chart-label">${escapeHtml(name)}</span>
          <div class="tmi-chart-bar-track">
            <div class="tmi-chart-bar" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="tmi-chart-count">${count}</span>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="tmi-trends-title">Tweet Volume by Topic (7 days)</div>
      ${barsHtml}
      <div class="tmi-trends-summary">
        <div>Total tweets this week: <strong>${recentTweets.length}</strong></div>
        <div>Average virality score: <strong>${avgVirality}</strong></div>
      </div>
    `;
  }

  // ── Tweet Extraction from DOM ──────────────────────────
  function extractTweetsFromDOM() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const tweets = [];

    articles.forEach(article => {
      try {
        // Get tweet link for unique ID
        const timeEl = article.querySelector('time');
        const linkEl = timeEl ? timeEl.closest('a') : null;
        const tweetUrl = linkEl ? linkEl.href : null;

        if (!tweetUrl) return;

        // Only process actual tweet status URLs
        const match = tweetUrl.match(/^https?:\/\/(x|twitter)\.com\/[^/]+\/status\/(\d+)/);
        if (!match) return;
        const tweetId = match[2];
        if (processedTweetIds.has(tweetId)) return;

        // Get tweet text
        const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
        const tweetText = tweetTextEl ? tweetTextEl.textContent.trim() : '';
        if (!tweetText || tweetText.length < 50) return; // skip short/image-only tweets

        // Get author info
        const userLinks = article.querySelectorAll('a[role="link"]');
        let author = '';
        let handle = '';
        let avatar = '';

        userLinks.forEach(link => {
          const href = link.getAttribute('href');
          if (href && href.match(/^\/[^/]+$/) && !handle) {
            handle = '@' + href.slice(1);
            const nameSpan = link.querySelector('span');
            if (nameSpan) author = nameSpan.textContent;
          }
        });

        const avatarImg = article.querySelector('img[src*="profile_images"]');
        if (avatarImg) avatar = avatarImg.src;

        // Skip ignored handles
        const handleLower = (handle || '').toLowerCase();
        const ignored = (settings.ignoredHandles || []).map(h => h.toLowerCase());
        if (ignored.some(h => handleLower === h || handleLower === '@' + h.replace('@', ''))) return;

        // Extract engagement metrics
        const engagement = extractEngagement(article);

        // Engagement filtering
        const metricField = settings.engagementMetric || 'likes';
        const minEngagement = settings.minEngagement || 0;
        if (minEngagement > 0 && (engagement[metricField] || 0) < minEngagement) return;

        tweets.push({
          id: tweetId,
          text: tweetText,
          url: tweetUrl,
          author: author || 'Unknown',
          handle: handle || '@unknown',
          avatar,
          likes: engagement.likes,
          retweets: engagement.retweets,
          replies: engagement.replies,
          bookmarks: engagement.bookmarks,
          views: engagement.views
        });
      } catch (e) {
        // Skip problematic tweets silently
      }
    });

    return tweets;
  }

  function extractEngagement(article) {
    const metrics = { likes: 0, retweets: 0, replies: 0, bookmarks: 0, views: 0 };
    // Like button
    const likeBtn = article.querySelector('[data-testid="like"]') || article.querySelector('[data-testid="unlike"]');
    if (likeBtn) metrics.likes = parseMetricNumber(likeBtn.getAttribute('aria-label'));
    // Retweet button
    const rtBtn = article.querySelector('[data-testid="retweet"]') || article.querySelector('[data-testid="unretweet"]');
    if (rtBtn) metrics.retweets = parseMetricNumber(rtBtn.getAttribute('aria-label'));
    // Reply button
    const replyBtn = article.querySelector('[data-testid="reply"]');
    if (replyBtn) metrics.replies = parseMetricNumber(replyBtn.getAttribute('aria-label'));
    // Bookmark
    const bookmarkBtn = article.querySelector('[data-testid="bookmark"]') || article.querySelector('[data-testid="removeBookmark"]');
    if (bookmarkBtn) metrics.bookmarks = parseMetricNumber(bookmarkBtn.getAttribute('aria-label'));
    // Views — look for analytics link with view count
    const viewSpans = article.querySelectorAll('a[href*="/analytics"] span');
    viewSpans.forEach(s => {
      const num = parseMetricNumber(s.textContent);
      if (num > 0) metrics.views = num;
    });
    return metrics;
  }

  function parseMetricNumber(text) {
    if (!text) return 0;
    const match = text.match(/([\d,.]+)\s*([KkMm])?/);
    if (!match) return 0;
    let num = parseFloat(match[1].replace(/,/g, ''));
    if (match[2] && (match[2] === 'K' || match[2] === 'k')) num *= 1000;
    if (match[2] && (match[2] === 'M' || match[2] === 'm')) num *= 1000000;
    return Math.round(num);
  }

  // ── Classification Pipeline ────────────────────────────
  async function processTweet(tweet) {
    if (!settings.apiKey) return;
    if (limitReached) {
      updateScanStatus(`Daily limit reached (${DAILY_LIMIT} tweets). Resets tomorrow.`, false);
      scanQueue = [];
      return;
    }

    if (processedTweetIds.has(tweet.id)) return;
    processedTweetIds.add(tweet.id);

    // Increment scanned count
    chrome.runtime.sendMessage({ type: 'INCREMENT_SCANNED' });

    try {
      activeCalls++;
      const queueMsg = scanQueue.length > 0 ? ` (${scanQueue.length} queued)` : '';
      updateScanStatus(`Analyzing tweet...${queueMsg}`, true);

      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'CLASSIFY_TWEET',
          text: tweet.text,
          apiKey: settings.apiKey,
          engagement: { likes: tweet.likes, retweets: tweet.retweets, replies: tweet.replies, bookmarks: tweet.bookmarks, views: tweet.views },
          topics: settings.marketTopics
        }, (response) => {
          if (response && response.success) {
            resolve(response.data);
          } else if (response?.error === 'DAILY_LIMIT_REACHED') {
            limitReached = true;
            reject(new Error('DAILY_LIMIT_REACHED'));
          } else {
            reject(new Error(response?.error || 'Classification failed'));
          }
        });
      });

      activeCalls--;
      dailyCount++;

      if (result.is_relevant && result.confidence >= 0.6) {
        // Map topic IDs back to {name, color} objects using settings
        const topicMap = {};
        (settings.marketTopics || []).forEach(t => { topicMap[t.id] = t; });
        const resolvedTopics = (result.topics || []).map(tid => {
          const t = topicMap[tid];
          return t ? { name: t.label, color: t.color } : { name: tid, color: '#4e8cff' };
        });

        const enrichedTweet = {
          ...tweet,
          topics: resolvedTopics,
          viralityScore: result.viralityScore || 0,
          hook: result.hook || '',
          sentiment: result.sentiment || '',
          summary: result.summary || '',
          designerRelevance: result.designerRelevance || '',
          viralityFramework: result.viralityFramework || 'none',
          confidence: result.confidence,
          foundAt: new Date().toISOString()
        };

        foundTweets.unshift(enrichedTweet);
        chrome.runtime.sendMessage({ type: 'SAVE_FOUND_TWEET', tweet: enrichedTweet });

        renderCards();
        updateBadge();
        updateScanStatus(`Found: ${result.summary || 'relevant tweet'}`, true);
      } else {
        const queueMsg = scanQueue.length > 0 ? ` (${scanQueue.length} queued)` : '';
        updateScanStatus(`Scanned ${processedTweetIds.size} tweets...${queueMsg}`, true);
      }
    } catch (err) {
      activeCalls--;
      if (err.message === 'DAILY_LIMIT_REACHED') {
        scanQueue = [];
        updateScanStatus(`Daily limit reached (${DAILY_LIMIT} tweets). Resets tomorrow.`, false);
        return;
      }
      console.warn('[TMI] Classification error:', err.message);
      updateScanStatus('Error \u2014 check API key', false);
    }

    // Process next in queue
    processQueue();
  }

  function processQueue() {
    while (scanQueue.length > 0 && activeCalls < MAX_CONCURRENT) {
      const tweet = scanQueue.shift();
      processTweet(tweet);
    }

    if (scanQueue.length === 0 && activeCalls === 0) {
      updateScanStatus(`Scanned ${processedTweetIds.size} tweets \u00B7 ${foundTweets.length} found`, false);
    }
  }

  function queueTweets(tweets) {
    tweets.forEach(t => {
      if (!processedTweetIds.has(t.id)) {
        scanQueue.push(t);
      }
    });
    processQueue();
  }

  // ── Feed Observer ──────────────────────────────────────
  let observer = null;
  let lastScanTime = 0;
  const SCAN_INTERVAL = 2000; // throttle: scan at most every 2s
  let trailingScanTimer = null;

  function startObserving() {
    if (observer) return;

    // Initial scan
    scanVisibleTweets();

    // Watch for new tweets appearing (infinite scroll)
    observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastScanTime >= SCAN_INTERVAL) {
        lastScanTime = now;
        scanVisibleTweets();
      } else {
        // Schedule a trailing scan to catch the last batch after mutations stop
        clearTimeout(trailingScanTimer);
        trailingScanTimer = setTimeout(() => {
          lastScanTime = Date.now();
          scanVisibleTweets();
        }, SCAN_INTERVAL);
      }
    });

    const timeline = document.querySelector('main') || document.body;
    observer.observe(timeline, {
      childList: true,
      subtree: true
    });

    updateScanStatus('Watching feed...', true);
  }

  function scanVisibleTweets() {
    if (isPaused) return;
    if (!settings.apiKey) {
      updateScanStatus('Set API key in extension popup', false);
      return;
    }

    // Only scan on home feed and search pages
    const path = window.location.pathname;
    if (path !== '/home' && !path.startsWith('/search')) return;

    const tweets = extractTweetsFromDOM();
    if (tweets.length > 0) {
      queueTweets(tweets);
    }
  }

  // ── Digest & Slack ─────────────────────────────────────
  async function generateDigest() {
    const btn = document.getElementById('tmi-generate-digest');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Generating...';
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentTweets = foundTweets.filter(t => {
      const d = t.foundAt ? new Date(t.foundAt) : null;
      return d && d >= sevenDaysAgo;
    });

    if (recentTweets.length === 0) {
      showToast('No tweets from the last 7 days to generate a report.');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '\u{1F4CB} Generate Report';
      }
      return;
    }

    try {
      const digest = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'GENERATE_DIGEST',
          tweets: recentTweets,
          apiKey: settings.apiKey
        }, (response) => {
          if (response && response.success) {
            resolve(response.digest);
          } else {
            reject(new Error(response?.error || 'Digest generation failed'));
          }
        });
      });

      digestHistory.unshift(digest);

      renderAnalytics();
      showToast('Report generated successfully!');
    } catch (err) {
      console.warn('[TMI] Digest error:', err.message);
      showToast('Failed to generate report. Check API key.');
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = '\u{1F4CB} Generate Report';
    }
  }

  async function sendToSlack(markdown) {
    if (!settings.slackWebhookUrl) {
      showToast('No Slack webhook URL configured.');
      return;
    }

    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'SEND_SLACK',
          webhookUrl: settings.slackWebhookUrl,
          markdown: markdown
        }, (response) => {
          if (response && response.success) {
            resolve(response);
          } else {
            reject(new Error(response?.error || 'Slack send failed'));
          }
        });
      });

      showToast('Sent to Slack successfully!');
    } catch (err) {
      console.warn('[TMI] Slack error:', err.message);
      showToast('Failed to send to Slack.');
    }
  }

  // ── Actions ────────────────────────────────────────────
  function clearAll() {
    if (!confirm('Clear all found tweets?')) return;
    foundTweets = [];
    processedTweetIds.clear();
    chrome.runtime.sendMessage({ type: 'CLEAR_TWEETS' });
    renderCards();
    updateBadge();
    updateScanStatus('Cleared. Watching feed...', true);
  }

  function removeTweet(id) {
    foundTweets = foundTweets.filter(t => t.id !== id);
    chrome.runtime.sendMessage({ type: 'DELETE_TWEET', tweetId: id });
    renderCards();
    updateBadge();
  }

  function exportContext() {
    const items = foundTweets.map(t => ({
      summary: t.summary,
      topics: (t.topics || []).map(tp => tp.name || tp),
      sentiment: t.sentiment,
      viralityScore: t.viralityScore,
      engagement: { likes: t.likes, retweets: t.retweets, replies: t.replies, views: t.views },
      author: t.handle,
      url: t.url,
      date: t.foundAt ? t.foundAt.slice(0, 10) : null
    }));

    const contextPayload = {
      _instruction: "This is a curated list of market intelligence tweets collected from Twitter/X. Use this as context for market analysis.",
      total: items.length,
      items: items
    };

    const data = JSON.stringify(contextPayload, null, 2);
    downloadFile(data, `tweet-market-intel-${new Date().toISOString().slice(0, 10)}.json`);
  }

  function copyContext() {
    const items = foundTweets.map(t => ({
      summary: t.summary,
      topics: (t.topics || []).map(tp => tp.name || tp),
      sentiment: t.sentiment,
      viralityScore: t.viralityScore,
      engagement: { likes: t.likes, retweets: t.retweets, replies: t.replies, views: t.views },
      author: t.handle,
      url: t.url
    }));

    const contextPayload = {
      _instruction: "This is a curated list of market intelligence tweets collected from Twitter/X. Use this as context for market analysis.",
      total: items.length,
      items: items
    };

    const text = JSON.stringify(contextPayload, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      showToast('Copied to clipboard!');
    }).catch(() => {
      downloadFile(text, `tweet-market-intel-${new Date().toISOString().slice(0, 10)}.json`);
    });
  }

  // ── Helpers ────────────────────────────────────────────
  function escapeHtml(str) {
    if (!str) return '';
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

  function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
  }

  function hexToRgba(hex, alpha) {
    // Handle shorthand or named colors by returning a fallback
    if (!hex || !hex.startsWith('#')) return `rgba(78, 140, 255, ${alpha})`;
    let r = 0, g = 0, b = 0;
    if (hex.length === 4) {
      r = parseInt(hex[1] + hex[1], 16);
      g = parseInt(hex[2] + hex[2], 16);
      b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length === 7) {
      r = parseInt(hex.slice(1, 3), 16);
      g = parseInt(hex.slice(3, 5), 16);
      b = parseInt(hex.slice(5, 7), 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function downloadFile(content, filename) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showToast(message) {
    let toast = document.getElementById('tmi-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'tmi-toast';
      toast.style.cssText = `
        position: fixed; bottom: 90px; left: 24px; z-index: 100000;
        background: #4e8cff; color: #fff; padding: 10px 18px;
        border-radius: 8px; font-family: 'JetBrains Mono', monospace;
        font-size: 12px; font-weight: 600; opacity: 0;
        transition: opacity 0.3s; pointer-events: none;
        box-shadow: 0 4px 16px rgba(78, 140, 255, 0.3);
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  }

  function markdownToHtml(md) {
    if (!md) return '';

    // Parse tables before escaping HTML (they need structural conversion)
    const lines = md.split('\n');
    const processed = [];
    let i = 0;
    while (i < lines.length) {
      // Detect table: line with pipes, followed by separator row (|---|---|)
      if (lines[i].includes('|') && i + 1 < lines.length && /^\|?\s*[-:]+[-|\s:]+$/.test(lines[i + 1])) {
        const headerCells = lines[i].split('|').map(c => c.trim()).filter(c => c);
        i += 2; // skip header + separator
        const bodyRows = [];
        while (i < lines.length && lines[i].includes('|') && !/^\|?\s*[-:]+[-|\s:]+$/.test(lines[i])) {
          bodyRows.push(lines[i].split('|').map(c => c.trim()).filter(c => c));
          i++;
        }
        let table = '<table class="tmi-table"><thead><tr>';
        headerCells.forEach(c => { table += `<th>${escapeHtml(c)}</th>`; });
        table += '</tr></thead><tbody>';
        bodyRows.forEach(row => {
          table += '<tr>';
          row.forEach(c => { table += `<td>${escapeHtml(c)}</td>`; });
          table += '</tr>';
        });
        table += '</tbody></table>';
        processed.push(table);
      } else {
        processed.push(escapeHtml(lines[i]));
        i++;
      }
    }

    let html = processed.join('\n');
    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/^\*\*\*$/gm, '<hr>');
    // Headers (must come before bold)
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Blockquotes (> lines) — must come before bold/italic
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');
    // Inline code for @handles
    html = html.replace(/@(\w{1,15})\b/g, '<code>@$1</code>');
    // Unordered lists (markdown - or * bullets, and • unicode bullets)
    html = html.replace(/^[•] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> in <ul>
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    // Line breaks for remaining lines (but not inside tables)
    html = html.replace(/\n/g, '<br>');
    // Clean up double <br> after block elements
    html = html.replace(/(<\/h[123]>)<br>/g, '$1');
    html = html.replace(/(<hr>)<br>/g, '$1');
    html = html.replace(/(<\/ul>)<br>/g, '$1');
    html = html.replace(/(<\/table>)<br>/g, '$1');
    html = html.replace(/(<\/blockquote>)<br>/g, '$1');
    return html;
  }

})();
