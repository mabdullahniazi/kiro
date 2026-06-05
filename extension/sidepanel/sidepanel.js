/**
 * TermsLens Side Panel Script
 * Handles setup, analysis, result rendering, and debug logs.
 */

const SCREENS = ['setup', 'idle', 'loading', 'no-links', 'error', 'results'];
const ERROR_MESSAGES = {
  NO_API_KEY: 'No API key is configured. Add your Gemini API key to continue.',
  INVALID_KEY: 'Gemini rejected this API key. Update it and try again.',
  DETECTION_FAILED: 'Could not scan this page for policy links.',
  EXTRACTION_FAILED: 'Could not extract readable text from any policy page.',
  ANALYSIS_FAILED: 'Gemini could not analyze the policy text.',
  SCORING_FAILED: 'The privacy score could not be calculated.',
  WORKFLOW_TIMEOUT: 'The analysis timed out. The site or Gemini may be slow.',
  NO_ACTIVE_TAB: 'Could not access the active tab.',
  UNEXPECTED_ERROR: 'An unexpected error occurred.',
};

let debugEntries = [];
let loadingTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showScreen(name) {
  for (const screen of SCREENS) {
    byId(`screen-${screen}`)?.classList.add('hidden');
  }
  byId(`screen-${name}`)?.classList.remove('hidden');
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs?.[0] ?? null);
    });
  });
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function setIdleDomain() {
  const tab = await getActiveTab();
  const host = hostnameFromUrl(tab?.url);
  byId('idle-domain').textContent = host ? host : 'Current tab';
}

function setSetupError(message) {
  const el = byId('setup-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function renderDebugEntry(entry) {
  const row = document.createElement('div');
  row.className = `debug-entry debug-entry-${entry.status || 'info'}`;

  const firstTs = debugEntries[0]?.ts ?? entry.ts;
  const elapsed = entry.ts && firstTs ? `+${entry.ts - firstTs}ms` : '';
  const detail = entry.detail
    ? `<pre>${escapeHtml(typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail, null, 2))}</pre>`
    : '';

  row.innerHTML = `
    <span class="debug-status">${escapeHtml(entry.status || 'info')}</span>
    <span class="debug-step">${escapeHtml(entry.step || 'step')}</span>
    <span class="debug-message">${escapeHtml(entry.message || '')}</span>
    <span class="debug-time">${escapeHtml(elapsed)}</span>
    ${detail}
  `;
  return row;
}

function renderDebugLog(entries = []) {
  debugEntries = Array.isArray(entries) ? entries : [];
  const container = byId('debug-entries');
  if (!container) return;
  container.innerHTML = '';
  for (const entry of debugEntries) {
    container.appendChild(renderDebugEntry(entry));
  }
  container.scrollTop = container.scrollHeight;
}

function appendDebugEntry(entry) {
  debugEntries.push(entry);
  const container = byId('debug-entries');
  if (!container) return;
  container.appendChild(renderDebugEntry(entry));
  container.scrollTop = container.scrollHeight;
}

function startLoadingText() {
  const messages = [
    'Scanning page links...',
    'Fetching policy documents...',
    'Extracting policy text...',
    'Sending text to Gemini...',
    'Building your privacy summary...',
  ];
  let index = 0;
  byId('loading-step').textContent = messages[index];
  byId('step-tracker').innerHTML = '';
  loadingTimer = setInterval(() => {
    index = (index + 1) % messages.length;
    byId('loading-step').textContent = messages[index];
  }, 2200);
}

function stopLoadingText() {
  clearInterval(loadingTimer);
  loadingTimer = null;
}

function renderStepTracker(entries = []) {
  const tracker = byId('step-tracker');
  if (!tracker) return;
  tracker.innerHTML = '';

  const latestByStep = new Map();
  for (const entry of entries) {
    latestByStep.set(entry.step, entry);
  }

  for (const entry of latestByStep.values()) {
    const row = document.createElement('div');
    row.className = `step-row step-row-${entry.status || 'info'}`;
    row.innerHTML = `
      <span>${escapeHtml(entry.status || 'info')}</span>
      <strong>${escapeHtml(entry.step || 'step')}</strong>
      <em>${escapeHtml(entry.message || '')}</em>
    `;
    tracker.appendChild(row);
  }
}

function scoreClass(score) {
  if (score === 10) return 'score-excellent';
  if (score >= 7) return 'score-low';
  if (score >= 4) return 'score-moderate';
  return 'score-high';
}

function renderList(id, items, emptyText, className = '') {
  const el = byId(id);
  if (!el) return;
  el.innerHTML = '';

  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-list-item';
    li.textContent = emptyText;
    el.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    if (className) li.className = className;
    li.textContent = String(item);
    el.appendChild(li);
  }
}

function renderFlags(flags) {
  const el = byId('result-flags');
  if (!el) return;
  el.innerHTML = '';

  if (!Array.isArray(flags) || flags.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-list-item';
    li.textContent = 'No major red flags detected.';
    el.appendChild(li);
    return;
  }

  for (const flag of flags) {
    const li = document.createElement('li');
    li.className = 'flag-item';
    li.innerHTML = `
      <strong>${escapeHtml(flag.category || 'Risk')}</strong>
      <span>${escapeHtml(flag.description || String(flag))}</span>
    `;
    el.appendChild(li);
  }
}

function renderDocs(linksFound) {
  const el = byId('docs-analysed');
  if (!el) return;
  el.innerHTML = '';

  if (!Array.isArray(linksFound) || linksFound.length === 0) {
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden');
  for (const doc of linksFound) {
    const pill = document.createElement('span');
    pill.className = `doc-pill doc-pill-${doc.source || 'fetched'}`;
    pill.textContent = `${String(doc.type || 'policy').replace(/-/g, ' ')} (${doc.source || 'fetched'})`;
    pill.title = doc.url || '';
    el.appendChild(pill);
  }
}

function renderWarnings(failures) {
  const el = byId('fetch-warnings');
  if (!el) return;

  if (!Array.isArray(failures) || failures.length === 0) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = failures.map(failure => (
    `<div><strong>${escapeHtml(failure.type || 'policy')}</strong>: ${escapeHtml(failure.reason || 'Failed')}<br><span>${escapeHtml(failure.url || '')}</span></div>`
  )).join('');
}

function renderResults(data) {
  const analysis = data.analysisResult || {};
  const scoreData = data.scoreData || { score: 0, label: 'Unknown' };
  const score = Number.isFinite(scoreData.score) ? scoreData.score : 0;
  const cssClass = scoreClass(score);

  byId('result-domain').textContent = data.domain || 'Current site';
  byId('score-ring').className = `score-ring ${cssClass}`;
  byId('score-number').textContent = String(score);
  byId('score-label').textContent = scoreData.label || 'Unknown';
  byId('score-label').className = `score-label ${cssClass}`;

  renderDocs(data.linksFound);
  renderWarnings(data.failures);

  byId('result-summary').textContent = analysis.summary || 'No summary was returned.';
  renderList('result-collected', analysis.dataCollected, 'None detected');
  renderList('result-shared', analysis.dataSharedWith, 'None detected');
  renderFlags(data.redFlags);
  renderList('result-rights', analysis.userRights, 'No specific rights found');
  byId('result-recommendation').textContent = analysis.recommendation || 'No recommendation was returned.';

  showScreen('results');
}

function showError(code, detail) {
  const message = ERROR_MESSAGES[code] || code || ERROR_MESSAGES.UNEXPECTED_ERROR;
  byId('error-message').textContent = detail ? `${message}\n\n${detail}` : message;
  byId('error-settings-btn').classList.toggle('hidden', !(code === 'NO_API_KEY' || code === 'INVALID_KEY'));
  showScreen('error');
}

async function startAnalysis() {
  renderDebugLog([]);
  showScreen('loading');
  startLoadingText();

  try {
    const response = await sendMessage({ action: 'START_ANALYSIS' });
    stopLoadingText();

    if (!response) {
      showError('UNEXPECTED_ERROR', 'The background script did not respond.');
      return;
    }

    renderDebugLog(response.debugLog || []);
    renderStepTracker(response.debugLog || []);

    if (!response.success) {
      if (response.error === 'NO_API_KEY') {
        showScreen('setup');
        return;
      }
      showError(response.error, response.detail);
      return;
    }

    if (response.noLinks) {
      showScreen('no-links');
      return;
    }

    renderResults(response);
  } catch (error) {
    stopLoadingText();
    appendDebugEntry({ step: 'sidepanel', status: 'error', message: error.message, ts: Date.now() });
    showError('UNEXPECTED_ERROR', error.message);
  }
}

async function saveSetupKey() {
  const input = byId('setup-key-input');
  const apiKey = input?.value.trim() || '';
  setSetupError('');

  if (!apiKey) {
    setSetupError('Please enter a Gemini API key.');
    return;
  }
  if (apiKey.length > 200) {
    setSetupError('API key must be 200 characters or fewer.');
    return;
  }

  try {
    const response = await sendMessage({ action: 'SAVE_API_KEY', apiKey });
    if (!response?.success) {
      setSetupError(response?.error || 'Could not save the API key.');
      return;
    }
    input.value = '';
    await setIdleDomain();
    showScreen('idle');
  } catch (error) {
    setSetupError(error.message);
  }
}

function openOptions() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    return;
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
}

async function initialize() {
  await setIdleDomain();

  try {
    const response = await sendMessage({ action: 'CHECK_API_KEY' });
    showScreen(response?.hasKey ? 'idle' : 'setup');
  } catch (error) {
    appendDebugEntry({ step: 'sidepanel', status: 'error', message: error.message, ts: Date.now() });
    showScreen('idle');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  byId('analyze-btn')?.addEventListener('click', startAnalysis);
  byId('reanalyze-btn')?.addEventListener('click', startAnalysis);
  byId('no-links-retry-btn')?.addEventListener('click', startAnalysis);
  byId('error-retry-btn')?.addEventListener('click', startAnalysis);

  byId('setup-save-btn')?.addEventListener('click', saveSetupKey);
  byId('setup-key-input')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') saveSetupKey();
  });

  byId('open-options')?.addEventListener('click', event => {
    event.preventDefault();
    openOptions();
  });
  byId('error-settings-btn')?.addEventListener('click', openOptions);

  byId('toggle-debug-btn')?.addEventListener('click', () => {
    byId('debug-panel')?.classList.toggle('hidden');
  });
  byId('clear-debug-btn')?.addEventListener('click', () => renderDebugLog([]));

  initialize();
});
