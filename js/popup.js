// popup.js — settings page logic for Tweet Market Intel

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const autoScanToggle = document.getElementById('autoScan');
  const pauseScanToggle = document.getElementById('pauseScan');
  const showSidebarToggle = document.getElementById('showSidebar');
  const saveBtn = document.getElementById('saveBtn');
  const statusEl = document.getElementById('status');
  const scannedEl = document.getElementById('scannedCount');
  const foundEl = document.getElementById('foundCount');

  // Topic inputs
  const topicInput = document.getElementById('topicInput');
  const topicColor = document.getElementById('topicColor');
  const addTopicBtn = document.getElementById('addTopic');
  const topicList = document.getElementById('topicList');

  // Handle inputs
  const handleInput = document.getElementById('handleInput');
  const addHandleBtn = document.getElementById('addHandle');
  const handleList = document.getElementById('handleList');

  // Slack & digest
  const slackWebhookInput = document.getElementById('slackWebhookUrl');
  const digestDaySelect = document.getElementById('digestDay');
  const minEngagementInput = document.getElementById('minEngagement');
  const engagementMetricSelect = document.getElementById('engagementMetric');

  let ignoredHandles = [];
  let marketTopics = [];

  // Load saved settings
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (data) => {
    if (!data) return;
    if (data.apiKey) apiKeyInput.value = data.apiKey;
    if (data.autoScan !== undefined) autoScanToggle.checked = data.autoScan;
    if (data.paused !== undefined) pauseScanToggle.checked = data.paused;
    if (data.showSidebar !== undefined) showSidebarToggle.checked = data.showSidebar;
    if (data.ignoredHandles) {
      ignoredHandles = data.ignoredHandles;
      renderHandles();
    }
    if (data.marketTopics) {
      marketTopics = data.marketTopics;
      renderTopics();
    }
    if (data.slackWebhookUrl) slackWebhookInput.value = data.slackWebhookUrl;
    if (data.digestDay !== undefined) digestDaySelect.value = data.digestDay;
    if (data.minEngagement !== undefined) minEngagementInput.value = data.minEngagement;
    if (data.engagementMetric) engagementMetricSelect.value = data.engagementMetric;
  });

  // Load stats
  chrome.runtime.sendMessage({ type: 'GET_FOUND_TWEETS' }, (data) => {
    if (!data) return;
    scannedEl.textContent = data.scannedCount || 0;
    foundEl.textContent = (data.foundTweets || []).length;
  });

  // Load daily count
  chrome.runtime.sendMessage({ type: 'GET_DAILY_COUNT' }, (data) => {
    const dailyEl = document.getElementById('dailyCount');
    if (dailyEl && data) {
      dailyEl.textContent = data.count || 0;
      if (data.count >= data.limit) dailyEl.style.color = '#ff3b5c';
    }
  });

  // ── Topics ──────────────────────────────────────────
  addTopicBtn.addEventListener('click', addTopic);
  topicInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTopic();
  });

  function addTopic() {
    const label = topicInput.value.trim();
    if (!label) return;
    if (marketTopics.some(t => t.label.toLowerCase() === label.toLowerCase())) return;

    marketTopics.push({
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      label,
      color: topicColor.value
    });
    renderTopics();
    topicInput.value = '';
  }

  function removeTopic(id) {
    marketTopics = marketTopics.filter(t => t.id !== id);
    renderTopics();
  }

  function renderTopics() {
    topicList.innerHTML = marketTopics.map(t =>
      `<span class="topic-chip" style="border-left-color:${t.color}">${t.label}<span class="remove-chip" data-topic-id="${t.id}">✕</span></span>`
    ).join('');

    topicList.querySelectorAll('.remove-chip').forEach(el => {
      el.addEventListener('click', () => removeTopic(el.dataset.topicId));
    });
  }

  // ── Handles ─────────────────────────────────────────
  addHandleBtn.addEventListener('click', addHandle);
  handleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addHandle();
  });

  function addHandle() {
    let handle = handleInput.value.trim();
    if (!handle) return;
    if (!handle.startsWith('@')) handle = '@' + handle;
    handle = handle.toLowerCase();

    if (!ignoredHandles.includes(handle)) {
      ignoredHandles.push(handle);
      renderHandles();
    }
    handleInput.value = '';
  }

  function removeHandle(handle) {
    ignoredHandles = ignoredHandles.filter(h => h !== handle);
    renderHandles();
  }

  function renderHandles() {
    handleList.innerHTML = ignoredHandles.map(h =>
      `<span class="handle-chip">${h}<span class="remove-chip" data-handle="${h}">✕</span></span>`
    ).join('');

    handleList.querySelectorAll('.remove-chip').forEach(el => {
      if (el.dataset.handle) {
        el.addEventListener('click', () => removeHandle(el.dataset.handle));
      }
    });
  }

  // ── Save ────────────────────────────────────────────
  saveBtn.addEventListener('click', () => {
    const settings = {
      apiKey: apiKeyInput.value.trim(),
      autoScan: autoScanToggle.checked,
      paused: pauseScanToggle.checked,
      showSidebar: showSidebarToggle.checked,
      ignoredHandles,
      marketTopics,
      slackWebhookUrl: slackWebhookInput.value.trim(),
      digestDay: parseInt(digestDaySelect.value, 10),
      minEngagement: parseInt(minEngagementInput.value, 10) || 0,
      engagementMetric: engagementMetricSelect.value
    };

    if (!settings.apiKey) {
      statusEl.textContent = '⚠ API key required';
      statusEl.style.color = '#ff3b5c';
      return;
    }

    if (settings.marketTopics.length === 0) {
      statusEl.textContent = '⚠ Add at least one market topic';
      statusEl.style.color = '#ff3b5c';
      return;
    }

    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, () => {
      statusEl.textContent = '✓ Settings saved';
      statusEl.style.color = '#00e5a0';

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'SETTINGS_UPDATED',
            settings
          });
        }
      });

      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    });
  });
});
