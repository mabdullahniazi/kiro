/**
 * TermsLens Side Panel Script
 * Handles: setup, idle, loading, no-links, error, results, history.
 * History is stored entirely in chrome.storage.local — no server.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const SCREENS = ['setup', 'idle', 'loading', 'no-links', 'error', 'results', 'history'];
const HISTORY_KEY    = 'termslens_history';
const HISTORY_MAX    = 50;   // max entries stored

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
let loadingTimer     = null;
let loadingIdx       = 0;
let lastResultData   = null;   // holds the last successful analysis so history can save it
let screenBeforeHist = 'idle'; // screen to return to when closing history

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
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

// ─── Storage helpers ──────────────────────────────────────────────────────────
function storageGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, d => resolve(d[key])));
}

function storageSet(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
}

// ─── History: read / write ────────────────────────────────────────────────────
async function historyLoad() {
  const raw = await storageGet(HISTORY_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function historySave(entries) {
  await storageSet(HISTORY_KEY, entries);
}

/**
 * Append a new analysis result to history.
 * Deduplicates by domain (most recent wins) and caps at HISTORY_MAX.
 */
async function historyAppend(data) {
  if (!data?.domain) return;

  const entry = {
    id:             Date.now(),
    domain:         data.domain,
    score:          data.scoreData?.score ?? 0,
    label:          data.scoreData?.label ?? 'Unknown',
    summary:        data.analysisResult?.summary ?? '',
    recommendation: data.analysisResult?.recommendation ?? '',
    redFlagCount:   Array.isArray(data.redFlags) ? data.redFlags.length : 0,
    redFlags:       data.redFlags ?? [],
    dataCollected:  data.analysisResult?.dataCollected ?? [],
    dataSharedWith: data.analysisResult?.dataSharedWith ?? [],
    userRights:     data.analysisResult?.userRights ?? [],
    linksFound:     data.linksFound ?? [],
    analysedAt:     Date.now(),
    // Keep the full analysisResult and scoreData so we can re-render it
    analysisResult: data.analysisResult ?? {},
    scoreData:      data.scoreData ?? {},
    failures:       data.failures ?? [],
  };

  let entries = await historyLoad();

  // Remove any existing entry for same domain (we'll put the new one at top)
  entries = entries.filter(e => e.domain !== entry.domain);

  // Prepend newest entry
  entries.unshift(entry);

  // Cap length
  if (entries.length > HISTORY_MAX) entries = entries.slice(0, HISTORY_MAX);

  await historySave(entries);
}

async function historyDelete(id) {
  let entries = await historyLoad();
  entries = entries.filter(e => e.id !== id);
  await historySave(entries);
}

async function historyClearAll() {
  await historySave([]);
}

// ─── History: render ──────────────────────────────────────────────────────────
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMs  = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr  = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1)  return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr  < 24) return `${diffHr}h ago`;
  if (diffDay < 7)  return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function scoreClassFromScore(score) {
  if (score === 10) return 'score-excellent';
  if (score >= 7)  return 'score-low';
  if (score >= 4)  return 'score-moderate';
  return 'score-high';
}

async function renderHistoryScreen() {
  const entries = await historyLoad();
  const listEl  = $('history-list');
  const emptyEl = $('history-empty');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (entries.length === 0) {
    emptyEl?.classList.remove('hidden');
    return;
  }

  emptyEl?.classList.add('hidden');

  for (const entry of entries) {
    const cls = scoreClassFromScore(entry.score);
    const li  = document.createElement('li');
    li.className = 'history-item';
    li.dataset.id = String(entry.id);

    li.innerHTML = `
      <div class="history-score-badge ${cls}">${entry.score}</div>
      <div class="history-body">
        <div class="history-domain">${esc(entry.domain)}</div>
        <div class="history-label ${cls}">${esc(entry.label)}</div>
        <div class="history-summary">${esc(entry.summary || 'No summary available.')}</div>
        <div class="history-meta">
          <span class="history-date">${esc(formatDate(entry.analysedAt))}</span>
          ${entry.redFlagCount > 0
            ? `<span class="history-flags-badge">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                ${entry.redFlagCount} concern${entry.redFlagCount !== 1 ? 's' : ''}
              </span>`
            : ''}
        </div>
      </div>
      <button class="history-del-btn" data-id="${entry.id}" title="Remove this entry" aria-label="Remove">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </button>
    `;

    // Click row → re-render that result
    li.addEventListener('click', (e) => {
      if (e.target.closest('.history-del-btn')) return; // don't trigger on delete button
      renderResults(entry);
      showScreen('results');
      // update the "back" target so results footer re-analyze goes back correctly
    });

    // Delete button
    li.querySelector('.history-del-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(e.currentTarget.dataset.id);
      await historyDelete(id);
      await renderHistoryScreen();
    });

    listEl.appendChild(li);
  }
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

// ─── Step tracker ─────────────────────────────────────────────────────────────
function renderStepTracker(entries = []) {
  const el = $('step-tracker');
  if (!el) return;
  el.innerHTML = '';

  const latest = new Map();
  for (const e of entries) latest.set(e.step, e);

  for (const e of latest.values()) {
    const icon = e.status === 'ok' ? '✓' : e.status === 'error' ? '✕' : e.status === 'warn' ? '!' : '·';
    const row = document.createElement('div');
    row.className = `step-row step-row-${e.status || 'info'}`;
    row.innerHTML = `
      <span class="s-icon s-icon-${e.status || 'info'}">${icon}</span>
      <span class="s-label">${esc(e.step)}</span>
      <span class="s-msg">${esc(e.message)}</span>
    `;
    el.appendChild(row);
  }
}

// ─── Score helpers ────────────────────────────────────────────────────────────
function scoreClass(s) {
  if (s === 10) return 'score-excellent';
  if (s >= 7)  return 'score-low';
  if (s >= 4)  return 'score-moderate';
  return 'score-high';
}

function scoreVerdict(score) {
  if (score === 10) return 'Excellent privacy practices. You can use this service with confidence.';
  if (score >= 8)   return 'Good privacy practices with only minor concerns.';
  if (score >= 7)   return 'Mostly fine, but worth checking the concerns below.';
  if (score >= 5)   return 'Mixed practices. Some things here could affect you — read the concerns below.';
  if (score >= 4)   return 'Several concerns. Understand what you are agreeing to before using this service.';
  if (score >= 2)   return 'Significant privacy concerns. Proceed carefully and read everything below.';
  return 'Very poor privacy practices. Consider avoiding this service or using it minimally.';
}

function flagsIntro(count) {
  if (count === 0) return '';
  if (count === 1) return 'There is 1 thing in this policy that could directly affect you:';
  return `There are ${count} things in this policy that could directly affect you:`;
}

// ─── Result section renderers ─────────────────────────────────────────────────
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
  const el    = $('result-flags');
  const intro = $('flags-intro');
  if (!el) return;
  el.innerHTML = '';

  if (intro) intro.textContent = flagsIntro(flags?.length ?? 0);

  if (!Array.isArray(flags) || flags.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-list-item';
    li.textContent = 'No major concerns detected — this policy looks relatively clean.';
    el.appendChild(li);
    return;
  }

  flags.forEach(f => {
    const li = document.createElement('li');
    li.className = 'flag-item';
    li.innerHTML = `
      <span class="flag-bullet">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </span>
      <div class="flag-body">
        <span class="flag-category">${esc(f.category || 'Risk')}</span>
        <p class="flag-desc">${esc(f.description || String(f))}</p>
      </div>
    `;
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
    el.classList.add('hidden'); el.innerHTML = ''; return;
  }
  el.classList.remove('hidden');
  el.innerHTML = failures.map(f =>
    `<div><strong>${esc(f.type || 'policy')}</strong>: ${esc(f.reason || 'Failed')} — <span>${esc(f.url || '')}</span></div>`
  ).join('');
}

function renderResults(data) {
  const analysis  = data.analysisResult || {};
  const scoreData = data.scoreData      || { score: 0, label: 'Unknown' };
  const score     = Number.isFinite(scoreData.score) ? scoreData.score : 0;
  const cls       = scoreClass(score);

  $('result-domain').textContent = data.domain || 'Current site';
  $('score-ring').className      = `score-ring ${cls}`;
  $('score-number').textContent  = String(score);
  $('score-label').textContent   = scoreData.label || 'Unknown';
  $('score-label').className     = `score-label ${cls}`;

  const verdictEl = $('score-verdict');
  if (verdictEl) verdictEl.textContent = scoreVerdict(score);

  renderDocs(data.linksFound);
  renderWarnings(data.failures);

  $('result-recommendation').textContent =
    analysis.recommendation || 'Review the policy details below before using this service.';

  renderFlags(data.redFlags);

  $('result-summary').textContent = analysis.summary || 'No summary was returned.';

  renderTagList('result-collected', analysis.dataCollected,  'Nothing specific was mentioned.');
  renderTagList('result-shared',    analysis.dataSharedWith, 'No third parties mentioned.');
  renderRightsList('result-rights', analysis.userRights);

  showScreen('results');
}

// ─── Error screen ─────────────────────────────────────────────────────────────
function showError(code, detail) {
  const msg = ERROR_MESSAGES[code] || code || ERROR_MESSAGES.UNEXPECTED_ERROR;
  $('error-message').textContent = detail ? `${msg}\n\nDetail: ${detail}` : msg;
  $('error-settings-btn').classList.toggle('hidden', !(code === 'NO_API_KEY' || code === 'INVALID_KEY'));
  showScreen('error');
}

// ─── Setup helpers ────────────────────────────────────────────────────────────
function setSetupError(msg) {
  const el = $('setup-error');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

// ─── Run analysis ─────────────────────────────────────────────────────────────
async function startAnalysis() {
  showScreen('loading');
  startLoading();

  try {
    const response = await sendMsg({ action: 'START_ANALYSIS' });
    stopLoading();

    if (!response) { showError('UNEXPECTED_ERROR', 'No response from background script.'); return; }

    renderStepTracker(response.debugLog || []);

    if (!response.success) {
      if (response.error === 'NO_API_KEY') { showScreen('setup'); return; }
      showError(response.error, response.detail);
      return;
    }

    if (response.noLinks) { showScreen('no-links'); return; }

    // Save to history before rendering
    lastResultData = response;
    await historyAppend(response);

    renderResults(response);
  } catch (err) {
    stopLoading();
    showError('UNEXPECTED_ERROR', err.message);
  }
}

// ─── Setup: save key ──────────────────────────────────────────────────────────
async function saveSetupKey() {
  setSetupError('');
  const key = ($('setup-key-input')?.value || '').trim();

  if (!key)             { setSetupError('Please enter your Gemini API key.'); return; }
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

// ─── History: open / close / clear ───────────────────────────────────────────
async function openHistory() {
  // Remember what screen we're coming from
  for (const s of SCREENS) {
    const el = $(`screen-${s}`);
    if (el && !el.classList.contains('hidden')) { screenBeforeHist = s; break; }
  }
  await renderHistoryScreen();
  showScreen('history');
}

function closeHistory() {
  showScreen(screenBeforeHist || 'idle');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Analysis
  $('analyze-btn')        ?.addEventListener('click', startAnalysis);
  $('reanalyze-btn')      ?.addEventListener('click', startAnalysis);
  $('no-links-retry-btn') ?.addEventListener('click', startAnalysis);
  $('error-retry-btn')    ?.addEventListener('click', startAnalysis);

  // Setup
  $('setup-save-btn') ?.addEventListener('click', saveSetupKey);
  $('setup-key-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveSetupKey(); });

  // Settings
  $('open-options')      ?.addEventListener('click', e => { e.preventDefault(); openOptions(); });
  $('error-settings-btn')?.addEventListener('click', openOptions);

  // History
  $('history-btn')?.addEventListener('click', openHistory);

  $('history-back-btn')?.addEventListener('click', closeHistory);

  $('history-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all saved history? This cannot be undone.')) return;
    await historyClearAll();
    await renderHistoryScreen();
  });

  init();
});
