/**
 * TermsLens Side Panel Script
 * Handles all screens: setup, idle, loading, no-links, error, results.
 * Includes full debug log panel.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const SCREENS = ['setup', 'idle', 'loading', 'no-links', 'error', 'results'];

const ERROR_MESSAGES = {
  NO_API_KEY:        'No API key configured. Add your Gemini API key to continue.',
  INVALID_KEY:       'Gemini rejected this API key (401/403). Update it and try again.',
  DETECTION_FAILED:  'Could not scan this page for policy links. Make sure the page has fully loaded.',
  EXTRACTION_FAILED: 'Could not extract readable text from any policy page.',
  ANALYSIS_FAILED:   'Gemini could not analyze the policy text. Check your API key and try again.',
  SCORING_FAILED:    'Privacy score calculation failed.',
  WORKFLOW_TIMEOUT:  'Analysis timed out (60s). The site or Gemini may be slow — try again.',
  NO_ACTIVE_TAB:     'Could not access the active tab.',
  UNEXPECTED_ERROR:  'An unexpected error occurred.',
};

const LOADING_STEPS = [
  'Scanning page for policy links…',
  'Fetching policy documents…',
  'Extracting legal text…',
  'Sending text to Gemini AI…',
  'Building privacy summary…',
  'Almost done…',
];

// ─── State ────────────────────────────────────────────────────────────────────
let debugEntries  = [];
let loadingTimer  = null;
let loadingIdx    = 0;

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const esc = v =>
  String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                 .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');

// ─── Screen management ────────────────────────────────────────────────────────
function showScreen(name) {
  SCREENS.forEach(s => $(`screen-${s}`)?.classList.add('hidden'));
  $(`screen-${name}`)?.classList.remove('hidden');
}

// ─── Chrome messaging ─────────────────────────────────────────────────────────
function sendMsg(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(response);
    });
  });
}

function getActiveTab() {
  return new Promise(resolve =>
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs?.[0] ?? null))
  );
}

// ─── Loading animation ────────────────────────────────────────────────────────
function startLoading() {
  loadingIdx = 0;
  const el = $('loading-step');
  if (el) el.textContent = LOADING_STEPS[0];
  $('step-tracker').innerHTML = '';
  loadingTimer = setInterval(() => {
    loadingIdx = (loadingIdx + 1) % LOADING_STEPS.length;
    if (el) el.textContent = LOADING_STEPS[loadingIdx];
  }, 2200);
}

function stopLoading() {
  clearInterval(loadingTimer);
  loadingTimer = null;
}

// ─── Step tracker (shown during loading) ──────────────────────────────────────
const STEP_ICONS = { ok: '✅', warn: '⚠️', error: '❌', info: '⏳' };

function renderStepTracker(entries = []) {
  const el = $('step-tracker');
  if (!el) return;
  el.innerHTML = '';

  // Show latest entry per step
  const latest = new Map();
  for (const e of entries) latest.set(e.step, e);

  for (const e of latest.values()) {
    const row = document.createElement('div');
    row.className = 'step-row';
    row.innerHTML = `
      <span class="s-icon">${STEP_ICONS[e.status] ?? 'ℹ️'}</span>
      <span class="s-label">${esc(e.step)}</span>
      <span class="s-msg">${esc(e.message)}</span>
    `;
    el.appendChild(row);
  }
}

// ─── Debug log panel ──────────────────────────────────────────────────────────
function renderDebugLog(entries = []) {
  debugEntries = Array.isArray(entries) ? entries : [];
  const container = $('debug-entries');
  if (!container) return;
  container.innerHTML = '';
  const t0 = debugEntries[0]?.ts ?? 0;
  for (const e of debugEntries) {
    container.appendChild(buildDebugRow(e, t0));
  }
  container.scrollTop = container.scrollHeight;
}

function buildDebugRow(e, t0) {
  const row = document.createElement('div');
  row.className = `debug-entry debug-entry-${e.status || 'info'}`;
  const elapsed = e.ts && t0 ? `+${e.ts - t0}ms` : '';
  const detail = e.detail
    ? `<pre>${esc(typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2))}</pre>`
    : '';
  row.innerHTML = `
    <span class="debug-status">${esc(e.status ?? 'info')}</span>
    <span class="debug-step">${esc(e.step ?? '')}</span>
    <span class="debug-message">${esc(e.message ?? '')}</span>
    <span class="debug-time">${esc(elapsed)}</span>
    ${detail}
  `;
  return row;
}

// ─── Score helpers ────────────────────────────────────────────────────────────
function scoreClass(s) {
  if (s === 10) return 'score-excellent';
  if (s >= 7)  return 'score-low';
  if (s >= 4)  return 'score-moderate';
  return 'score-high';
}

// ─── Results rendering ────────────────────────────────────────────────────────
function renderTagList(id, items, emptyText) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-list-item';
    li.textContent = emptyText;
    el.appendChild(li);
    return;
  }
  items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = String(item);
    el.appendChild(li);
  });
}

function renderRightsList(id, items) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-list-item';
    li.textContent = 'No specific rights identified.';
    el.appendChild(li);
    return;
  }
  items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = String(item);
    el.appendChild(li);
  });
}

function renderFlags(flags) {
  const el = $('result-flags');
  if (!el) return;
  el.innerHTML = '';
  if (!Array.isArray(flags) || flags.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-list-item';
    li.textContent = 'No major red flags detected.';
    el.appendChild(li);
    return;
  }
  flags.forEach(f => {
    const li = document.createElement('li');
    li.className = 'flag-item';
    li.innerHTML = `<strong>${esc(f.category || 'Risk')}</strong><span>${esc(f.description || String(f))}</span>`;
    el.appendChild(li);
  });
}

function renderDocs(linksFound) {
  const el = $('docs-analysed');
  if (!el) return;
  el.innerHTML = '';
  if (!Array.isArray(linksFound) || linksFound.length === 0) return;
  linksFound.forEach(doc => {
    const span = document.createElement('span');
    span.className = `doc-pill doc-pill-${doc.source || 'fetched'}`;
    span.textContent = `${String(doc.type || 'policy').replace(/-/g,' ')} · ${doc.source || 'fetched'}`;
    span.title = doc.url || '';
    el.appendChild(span);
  });
}

function renderWarnings(failures) {
  const el = $('fetch-warnings');
  if (!el) return;
  if (!Array.isArray(failures) || failures.length === 0) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = failures.map(f =>
    `<div><strong>${esc(f.type || 'policy')}</strong>: ${esc(f.reason || 'Failed')} — <span>${esc(f.url || '')}</span></div>`
  ).join('');
}

function renderResults(data) {
  const analysis  = data.analysisResult || {};
  const scoreData = data.scoreData || { score: 0, label: 'Unknown' };
  const score     = Number.isFinite(scoreData.score) ? scoreData.score : 0;
  const cls       = scoreClass(score);

  $('result-domain').textContent = data.domain || 'Current site';
  $('score-ring').className    = `score-ring ${cls}`;
  $('score-number').textContent = String(score);
  $('score-label').textContent  = scoreData.label || 'Unknown';
  $('score-label').className    = `score-label ${cls}`;

  renderDocs(data.linksFound);
  renderWarnings(data.failures);

  $('result-summary').textContent = analysis.summary || 'No summary returned.';
  renderTagList('result-collected', analysis.dataCollected,  'None detected');
  renderTagList('result-shared',    analysis.dataSharedWith, 'None detected');
  renderFlags(data.redFlags);
  renderRightsList('result-rights', analysis.userRights);
  $('result-recommendation').textContent = analysis.recommendation || 'No recommendation returned.';

  showScreen('results');
}

// ─── Error screen ─────────────────────────────────────────────────────────────
function showError(code, detail) {
  const msg = ERROR_MESSAGES[code] || code || ERROR_MESSAGES.UNEXPECTED_ERROR;
  $('error-message').textContent = detail ? `${msg}\n\nDetail: ${detail}` : msg;
  $('error-settings-btn').classList.toggle('hidden', !(code === 'NO_API_KEY' || code === 'INVALID_KEY'));
  showScreen('error');
}

// ─── Setup screen helpers ─────────────────────────────────────────────────────
function setSetupError(msg) {
  const el = $('setup-error');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

// ─── Core: run analysis ───────────────────────────────────────────────────────
async function startAnalysis() {
  renderDebugLog([]);
  showScreen('loading');
  startLoading();

  try {
    const response = await sendMsg({ action: 'START_ANALYSIS' });
    stopLoading();

    if (!response) {
      showError('UNEXPECTED_ERROR', 'No response from background script.');
      return;
    }

    // Populate debug log + step tracker with pipeline data
    renderDebugLog(response.debugLog || []);
    renderStepTracker(response.debugLog || []);

    if (!response.success) {
      if (response.error === 'NO_API_KEY') { showScreen('setup'); return; }
      showError(response.error, response.detail);
      return;
    }

    if (response.noLinks) { showScreen('no-links'); return; }

    renderResults(response);
  } catch (err) {
    stopLoading();
    renderDebugLog([{ step: 'sidepanel', status: 'error', message: err.message, ts: Date.now() }]);
    showError('UNEXPECTED_ERROR', err.message);
  }
}

// ─── Setup: save API key ──────────────────────────────────────────────────────
async function saveSetupKey() {
  setSetupError('');
  const key = ($('setup-key-input')?.value || '').trim();

  if (!key)          { setSetupError('Please enter your Gemini API key.'); return; }
  if (key.length > 200) { setSetupError('Key too long (max 200 chars).'); return; }

  try {
    const res = await sendMsg({ action: 'SAVE_API_KEY', apiKey: key });
    if (!res?.success) { setSetupError(res?.error || 'Could not save key.'); return; }
    $('setup-key-input').value = '';
    await updateIdleDomain();
    showScreen('idle');
  } catch (err) {
    setSetupError(err.message);
  }
}

// ─── Idle: show current domain ────────────────────────────────────────────────
async function updateIdleDomain() {
  const tab = await getActiveTab();
  let host = '';
  try { host = tab?.url ? new URL(tab.url).hostname : ''; } catch {}
  $('idle-domain').textContent = host || 'Current page';
}

// ─── Options page ─────────────────────────────────────────────────────────────
function openOptions() {
  chrome.runtime.openOptionsPage
    ? chrome.runtime.openOptionsPage()
    : chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await updateIdleDomain();
  try {
    const res = await sendMsg({ action: 'CHECK_API_KEY' });
    showScreen(res?.hasKey ? 'idle' : 'setup');
  } catch {
    showScreen('idle');
  }
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Analysis triggers
  $('analyze-btn')       ?.addEventListener('click', startAnalysis);
  $('reanalyze-btn')     ?.addEventListener('click', startAnalysis);
  $('no-links-retry-btn')?.addEventListener('click', startAnalysis);
  $('error-retry-btn')   ?.addEventListener('click', startAnalysis);

  // Setup
  $('setup-save-btn')?.addEventListener('click', saveSetupKey);
  $('setup-key-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveSetupKey(); });

  // Settings
  $('open-options')?.addEventListener('click', e => { e.preventDefault(); openOptions(); });
  $('error-settings-btn')?.addEventListener('click', openOptions);

  // Debug panel
  $('toggle-debug-btn')?.addEventListener('click', () => $('debug-panel')?.classList.toggle('hidden'));
  $('clear-debug-btn')  ?.addEventListener('click', () => renderDebugLog([]));

  init();
});
