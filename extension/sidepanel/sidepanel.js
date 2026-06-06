/**
 * TermsLens Side Panel Script
 * Handles: setup, idle, loading, no-links, error, results, history.
 * History is stored entirely in chrome.storage.local — no server.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const SCREENS = ['setup', 'idle', 'loading', 'no-links', 'error', 'results', 'history', 'settings'];
const HISTORY_KEY    = 'termslens_history';
const HISTORY_MAX    = 50;   // max entries stored
const CHAT_HISTORY_MAX = 80;
const CHAT_TEXT_MAX    = 4000;

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
let loadingTimer       = null;
let loadingIdx         = 0;
let lastResultData     = null;
let activeHistoryId    = null;
let deletedHistoryIds  = new Set();
let screenBeforeSecond = 'idle'; // screen to return to from history/settings

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

function sanitizeChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && (m.role === 'user' || m.role === 'ai') && typeof m.text === 'string')
    .slice(-CHAT_HISTORY_MAX)
    .map(m => ({
      role: m.role,
      text: m.text.slice(0, CHAT_TEXT_MAX),
      isGuard: !!m.isGuard,
      modelLabel: typeof m.modelLabel === 'string' ? m.modelLabel.slice(0, 80) : '',
      ts: Number.isFinite(m.ts) ? m.ts : Date.now(),
    }));
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
    modelUsed:      data.modelUsed ?? '',
    chatMessages:   sanitizeChatMessages(data.chatMessages),
  };

  let entries = await historyLoad();

  // Remove any existing entry for same domain (we'll put the new one at top)
  entries
    .filter(e => e.domain === entry.domain)
    .forEach(e => deletedHistoryIds.add(e.id));
  entries = entries.filter(e => e.domain !== entry.domain);

  // Prepend newest entry
  entries.unshift(entry);

  // Cap length
  if (entries.length > HISTORY_MAX) entries = entries.slice(0, HISTORY_MAX);

  await historySave(entries);
  return entry;
}

async function historyDelete(id) {
  deletedHistoryIds.add(id);
  let entries = await historyLoad();
  entries = entries.filter(e => e.id !== id);
  await historySave(entries);
  if (activeHistoryId === id) activeHistoryId = null;
  if (lastResultData?.id === id) lastResultData = null;
}

async function historyClearAll() {
  const entries = await historyLoad();
  entries.forEach(e => deletedHistoryIds.add(e.id));
  await historySave([]);
  activeHistoryId = null;
  lastResultData = null;
}

async function historyUpdateChat(id, messages) {
  if (!id) return;
  if (deletedHistoryIds.has(id)) return;
  const entries = await historyLoad();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return;

  const chatMessages = sanitizeChatMessages(messages);
  entries[idx] = {
    ...entries[idx],
    chatMessages,
    chatUpdatedAt: Date.now(),
  };
  if (deletedHistoryIds.has(id)) return;
  await historySave(entries);

  if (lastResultData?.id === id) {
    lastResultData = { ...lastResultData, chatMessages };
  }
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


function renderDocs(linksFound) {
  const el = $('docs-analysed');
  if (!el) return;
  el.innerHTML = '';
  if (!Array.isArray(linksFound) || linksFound.length === 0) return;
  linksFound.forEach(doc => {
    const wrapper = document.createElement('div');
    wrapper.className = 'doc-link-row';

    const pill = document.createElement('span');
    pill.className = `doc-pill doc-pill-${doc.source || 'fetched'}`;
    pill.textContent = String(doc.type || 'policy').replace(/-/g, ' ');

    const link = document.createElement('a');
    link.href   = doc.url || '#';
    link.target = '_blank';
    link.rel    = 'noopener noreferrer';
    link.className = 'doc-url-link';
    link.textContent = doc.url || '';
    link.title = doc.url || '';

    wrapper.appendChild(pill);
    wrapper.appendChild(link);
    el.appendChild(wrapper);
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
  activeHistoryId = data.id ?? null;
  lastResultData = data;

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

  // Render summary — prefer summaryPoints array, fall back to summary string
  const summaryEl = $('result-summary');
  if (summaryEl) {
    summaryEl.innerHTML = '';
    const points = Array.isArray(analysis.summaryPoints) && analysis.summaryPoints.length > 0
      ? analysis.summaryPoints
      : null;

    if (points) {
      const ul = document.createElement('ul');
      ul.className = 'summary-list';
      points.forEach(line => {
        const li = document.createElement('li');
        li.textContent = String(line).replace(/^[\d]+[.)]\s*/, '').replace(/^[•\-]\s*/, '').trim();
        ul.appendChild(li);
      });
      summaryEl.appendChild(ul);
    } else {
      // Fall back to plain string, split on newlines
      const raw = analysis.summary || 'No summary was returned.';
      const lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);
      if (lines.length <= 1) {
        summaryEl.textContent = raw;
      } else {
        const ul = document.createElement('ul');
        ul.className = 'summary-list';
        lines.forEach(line => {
          const li = document.createElement('li');
          li.textContent = line.replace(/^[\d]+[.)]\s*/, '').replace(/^[•\-]\s*/, '').trim();
          ul.appendChild(li);
        });
        summaryEl.appendChild(ul);
      }
    }
  }

  renderFlags(data.redFlags);
  renderTagList('result-collected', analysis.dataCollected,  'Nothing specific was mentioned.');
  renderTagList('result-shared',    analysis.dataSharedWith, 'No third parties mentioned.');
  renderRightsList('result-rights', analysis.userRights);

  // Store context for chat and restore any saved thread for this scan.
  setChatContext({ ...data, modelUsed: data.modelUsed || '' });
  renderStoredChat(data.chatMessages);

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
    const savedEntry = await historyAppend(response);
    lastResultData = savedEntry || response;

    renderResults(lastResultData);
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

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await updateIdleDomain();
  try {
    const res = await sendMsg({ action: 'CHECK_API_KEY' });
    if (res?.hasKey) {
      showScreen('idle');
      // Check if we have a prior result for this domain and suggest it
      await checkHistorySuggestion();
    } else {
      showScreen('setup');
    }
  } catch {
    showScreen('idle');
  }
}

// ─── Settings screen ──────────────────────────────────────────────────────────
async function updateSettingsStatus() {
  const key = await storageGet('geminiApiKey');
  const hasKey = !!(key && key.trim());
  const dot  = $('settings-status-dot');
  const text = $('settings-status-text');
  if (dot)  dot.className  = `settings-status-dot ${hasKey ? 'active' : 'inactive'}`;
  if (text) text.textContent = hasKey ? '✓ API key is configured' : 'No API key configured';
}

function showSettingsFeedback(msg, type) {
  const el = $('settings-feedback');
  if (!el) return;
  el.textContent = msg;
  el.className   = `settings-feedback ${type}`;
  el.classList.remove('hidden');
  clearTimeout(showSettingsFeedback._t);
  showSettingsFeedback._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function openSettings() {
  // Remember the screen we came from
  for (const s of SCREENS) {
    const el = $(`screen-${s}`);
    if (el && !el.classList.contains('hidden')) { screenBeforeSecond = s; break; }
  }
  // Reset input
  const inp = $('settings-key-input');
  if (inp) { inp.value = ''; inp.type = 'password'; }
  const eye = $('settings-eye-icon');
  if (eye) eye.innerHTML = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
  $('settings-feedback')?.classList.add('hidden');
  await updateSettingsStatus();
  showScreen('settings');
}

function closeSettings() {
  showScreen(screenBeforeSecond || 'idle');
}

async function settingsSaveKey() {
  const key = ($('settings-key-input')?.value || '').trim();
  if (!key)             { showSettingsFeedback('Please enter an API key.', 'error'); return; }
  if (key.length > 200) { showSettingsFeedback('Key too long (max 200 chars).', 'error'); return; }

  try {
    const res = await sendMsg({ action: 'SAVE_API_KEY', apiKey: key });
    if (!res?.success) { showSettingsFeedback(res?.error || 'Could not save key.', 'error'); return; }
    $('settings-key-input').value = '';
    $('settings-key-input').type  = 'password';
    await updateSettingsStatus();
    showSettingsFeedback('✓ API key saved.', 'success');
  } catch (err) {
    showSettingsFeedback(err.message, 'error');
  }
}

async function settingsRemoveKey() {
  if (!confirm('Remove your stored API key? You will need to re-enter it to use TermsLens.')) return;
  try {
    await sendMsg({ action: 'CLEAR_API_KEY' });
    await updateSettingsStatus();
    showSettingsFeedback('API key removed.', 'success');
  } catch (err) {
    showSettingsFeedback(err.message, 'error');
  }
}

// ─── Chat state ───────────────────────────────────────────────────────────────
let chatPolicyContext  = '';   // injected once as the first system turn
let chatDomain         = '';
let chatModel          = '';   // model that succeeded for this scan session
let chatContextInjected = false; // ensure we only inject context once per scan
let chatMessages       = [];
let chatPersistQueue   = Promise.resolve();

/**
 * Called once after a successful scan. Stores context for the chat session.
 * Records which Gemini model succeeded so we reuse it for all chat turns.
 */
function setChatContext(data) {
  chatDomain  = data.domain || '';
  chatModel   = data.modelUsed || '';   // passed from background
  chatContextInjected = false;           // reset so next scan gets a fresh injection

  const a = data.analysisResult || {};
  chatPolicyContext = [
    `This is the privacy analysis result for ${chatDomain}.`,
    `Summary: ${a.summary || 'Not available.'}`,
    `Data collected: ${(a.dataCollected || []).join(', ') || 'None listed.'}`,
    `Data shared with: ${(a.dataSharedWith || []).join(', ') || 'None listed.'}`,
    `Red flags: ${(a.redFlags || []).join('; ') || 'None found.'}`,
    `User rights: ${(a.userRights || []).join('; ') || 'None listed.'}`,
    `Recommendation: ${a.recommendation || 'Not available.'}`,
  ].join('\n');

  // Update the model badge in the chat header
  const badge = $('chat-model-badge');
  if (badge) {
    if (chatModel) {
      badge.textContent = chatModel;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function clearChat() {
  const msgs = $('chat-messages');
  if (msgs) msgs.innerHTML = '';
  $('chat-suggestions')?.classList.remove('hidden');
  chatContextInjected = false;
  chatMessages = [];
}

function appendChatTextWithBold(parent, text) {
  const value = String(text ?? '');
  const boldPattern = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let cursor = 0;
  let match;

  while ((match = boldPattern.exec(value)) !== null) {
    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(value.slice(cursor, match.index)));
    }

    const boldText = (match[1] ?? match[2] ?? '').trim();
    if (boldText) {
      const strong = document.createElement('strong');
      strong.textContent = boldText;
      parent.appendChild(strong);
    } else {
      parent.appendChild(document.createTextNode(match[0]));
    }

    cursor = boldPattern.lastIndex;
  }

  if (cursor < value.length) {
    parent.appendChild(document.createTextNode(value.slice(cursor)));
  }
}

function queueChatPersist() {
  if (!activeHistoryId) return;
  const historyId = activeHistoryId;
  const snapshot = sanitizeChatMessages(chatMessages);
  chatPersistQueue = chatPersistQueue
    .catch(() => {})
    .then(() => historyUpdateChat(historyId, snapshot))
    .catch(err => console.error('[TermsLens:chat] Could not save chat history:', err));
}

function formatChatTranscript(messages) {
  return sanitizeChatMessages(messages)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n');
}

function renderStoredChat(messages) {
  const stored = sanitizeChatMessages(messages);
  const msgs = $('chat-messages');
  if (msgs) msgs.innerHTML = '';
  chatMessages = [];
  chatContextInjected = stored.length > 0;

  if (stored.length === 0) {
    $('chat-suggestions')?.classList.remove('hidden');
    return;
  }

  $('chat-suggestions')?.classList.add('hidden');
  stored.forEach(message => {
    appendChatMessage(message.role, message.text, message.isGuard, message.modelLabel, {
      persist: false,
      ts: message.ts,
    });
  });
  chatMessages = stored;
}

function appendChatMessage(role, text, isGuard = false, modelLabel = '', options = {}) {
  const msgs = $('chat-messages');
  if (!msgs) return;

  $('chat-suggestions')?.classList.add('hidden');

  const wrapper = document.createElement('div');
  wrapper.className = `chat-msg chat-msg--${role}${isGuard ? ' chat-msg--guard' : ''}`;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  appendChatTextWithBold(bubble, text);

  const meta = document.createElement('div');
  meta.className = 'chat-ts';
  const ts = Number.isFinite(options.ts) ? options.ts : Date.now();
  const timeStr = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = modelLabel ? `${timeStr} · ${modelLabel}` : timeStr;

  wrapper.appendChild(bubble);
  wrapper.appendChild(meta);
  msgs.appendChild(wrapper);
  msgs.scrollTop = msgs.scrollHeight;

  if (options.persist !== false) {
    chatMessages = sanitizeChatMessages([
      ...chatMessages,
      { role, text: String(text ?? ''), isGuard, modelLabel, ts },
    ]);
    queueChatPersist();
  }

  return wrapper;
}

function appendLoadingBubble() {
  const msgs = $('chat-messages');
  if (!msgs) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg chat-msg--ai';

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble--loading';
  bubble.innerHTML = `<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>`;

  wrapper.appendChild(bubble);
  msgs.appendChild(wrapper);
  msgs.scrollTop = msgs.scrollHeight;
  return wrapper;
}

function getCandidateText(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function sendChatQuestion(question) {
  if (!question.trim()) return;
  if (!chatPolicyContext) {
    appendChatMessage('ai', 'Please run an analysis first so I have a policy to answer questions about.');
    return;
  }

  const sendBtn = $('chat-send-btn');
  const input   = $('chat-input');
  if (sendBtn) sendBtn.disabled = true;
  if (input)   input.value = '';

  appendChatMessage('user', question);
  const previousChatTranscript = formatChatTranscript(chatMessages.slice(0, -1));
  const loadingEl = appendLoadingBubble();

  try {
    // ── Get API key directly from storage ───────────────────────────────────
    const apiKey = await new Promise(resolve =>
      chrome.storage.local.get('geminiApiKey', d => resolve((d.geminiApiKey || '').trim() || null))
    );

    if (!apiKey) {
      loadingEl?.remove();
      appendChatMessage('ai', 'No API key configured. Please add it in Settings.', false);
      return;
    }

    // ── Guardrail — only block clearly off-topic requests ───────────────────
    const BLOCKED = [
      /\bweather\b|\bforecast\b/i,
      /\brecipe\b|\bcook(ing)?\b/i,
      /\bsports? score\b|\bnfl\b|\bnba\b/i,
      /\bbitcoin\b|\bcrypto\b/i,
      /\bjoke\b|\bfunny\b|\bmeme\b/i,
    ];

    if (BLOCKED.some(p => p.test(question))) {
      loadingEl?.remove();
      appendChatMessage(
        'ai',
        `I can only answer questions about ${chatDomain || 'this site'}'s policy. Try asking about data collection, your rights, or what a specific concern means.`,
        true
      );
      return;
    }

    // ── Build prompt ─────────────────────────────────────────────────────────
    const systemPart = [
      `You are a plain-English legal assistant answering questions about ${chatDomain || 'a website'}'s privacy policy.`,
      `Here is the privacy analysis context:\n${chatPolicyContext}`,
      previousChatTranscript ? `Previous chat:\n${previousChatTranscript}` : '',
      'Use the policy context and previous chat to answer the current question. Plain English, under 150 words. If a question is unrelated to this policy, politely say you can only answer policy questions.',
      '',
    ].filter(Boolean).join('\n\n');

    const fullPrompt = `${systemPart}Question: ${question}`;

    // Only use models confirmed to work with this API key
    const MODELS = [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ].filter((m, i, arr) => arr.indexOf(m) === i);

    let answer    = null;
    let usedModel = '';
    let lastError = '';

    for (const tryModel of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(tryModel)}:generateContent?key=${apiKey}`;
      try {
        const res = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            contents: [{ parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
          }),
        });

        if (res.status === 401 || res.status === 403) {
          lastError = 'API key rejected.';
          break;  // no point trying other models
        }

        if (res.status === 429) {
          lastError = `${tryModel}: quota exceeded`;
          continue;
        }

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          lastError = `${tryModel}: HTTP ${res.status} — ${errBody.slice(0, 100)}`;
          console.error('[TermsLens:chat]', lastError);
          continue;
        }

        const data = await res.json();
        const text = getCandidateText(data?.candidates?.[0]);

        if (!text) {
          const reason = data?.candidates?.[0]?.finishReason || 'empty';
          lastError = `${tryModel}: empty response (${reason})`;
          console.warn('[TermsLens:chat]', lastError);
          continue;
        }

        answer    = text;
        usedModel = tryModel;
        break;

      } catch (fetchErr) {
        lastError = `${tryModel}: ${fetchErr.message}`;
        console.error('[TermsLens:chat] fetch error:', fetchErr.message);
        continue;
      }
    }

    loadingEl?.remove();

    if (!answer) {
      appendChatMessage('ai', `Sorry, could not get an answer. ${lastError ? `(${lastError})` : 'Please try again.'}`);
      return;
    }

    // Mark context as injected after first successful answer
    if (!chatContextInjected) chatContextInjected = true;

    const displayModel = usedModel.replace('gemini-', 'Gemini ');
    appendChatMessage('ai', answer, false, displayModel);

    // Lock in this model for the whole session
    if (!chatModel && usedModel) {
      chatModel = usedModel;
      const badge = $('chat-model-badge');
      if (badge) { badge.textContent = displayModel; badge.classList.remove('hidden'); }
    }

  } catch (err) {
    loadingEl?.remove();
    console.error('[TermsLens:chat] unexpected error:', err);
    appendChatMessage('ai', `Error: ${err.message}`);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (input)   input.focus();
  }
}

// ─── Flag drawer — click a red flag to expand/collapse detail ─────────────────
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

  flags.forEach((f, idx) => {
    const li = document.createElement('li');
    li.className = 'flag-item flag-item--collapsible';
    li.setAttribute('role', 'button');
    li.setAttribute('aria-expanded', 'false');
    li.setAttribute('tabindex', '0');
    li.dataset.idx = String(idx);

    const desc = f.description || String(f);
    // Build a more detailed explanation for the drawer
    const detail = `What this means for you: ${desc} If you are concerned about this, consider reaching out to the company to ask how this affects you specifically, or look for an opt-out option in your account settings.`;

    li.innerHTML = `
      <div class="flag-row">
        <span class="flag-bullet">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </span>
        <div class="flag-body">
          <span class="flag-category">${esc(f.category || 'Risk')}</span>
          <p class="flag-desc">${esc(desc)}</p>
        </div>
        <span class="flag-chevron" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
      </div>
      <div class="flag-drawer" aria-hidden="true">
        <p class="flag-drawer-text">${esc(detail)}</p>
        <button class="flag-ask-btn" data-q="Explain in detail: ${esc(desc)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Ask AI to explain this
        </button>
      </div>
    `;

    // Toggle drawer on click / Enter / Space
    const toggle = () => {
      const isOpen = li.getAttribute('aria-expanded') === 'true';
      li.setAttribute('aria-expanded', String(!isOpen));
      const drawer = li.querySelector('.flag-drawer');
      if (drawer) drawer.setAttribute('aria-hidden', String(isOpen));
    };

    li.addEventListener('click', (e) => {
      // If the "Ask AI" button was clicked, handle separately
      if (e.target.closest('.flag-ask-btn')) return;
      toggle();
    });
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    // "Ask AI to explain this" button scrolls to chat and pre-fills the question
    li.querySelector('.flag-ask-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const q = `Explain this concern in more detail: ${desc}`;
      const chatInput = $('chat-input');
      if (chatInput) {
        chatInput.value = q;
        chatInput.focus();
        // Scroll chat panel into view
        document.querySelector('.chat-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    el.appendChild(li);
  });
}
async function checkHistorySuggestion() {
  const tab = await getActiveTab();
  if (!tab?.url) return;
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { return; }
  if (!host) return;

  const entries = await historyLoad();
  const match   = entries.find(e => e.domain === host);
  if (!match) return;

  const suggEl  = $('history-suggestion');
  const textEl  = $('history-suggestion-text');
  if (!suggEl || !textEl) return;

  textEl.textContent = `You analyzed ${host} ${formatDate(match.analysedAt)} — score was ${match.score}/10 (${match.label}). Use that or run a fresh scan?`;
  suggEl.classList.remove('hidden');

  // Attach handlers each time (remove old ones first)
  const useBtn  = $('use-cached-btn');
  const freshBtn = $('scan-fresh-btn');

  const newUse = useBtn?.cloneNode(true);
  const newFresh = freshBtn?.cloneNode(true);
  useBtn?.parentNode?.replaceChild(newUse, useBtn);
  freshBtn?.parentNode?.replaceChild(newFresh, freshBtn);

  newUse?.addEventListener('click', () => {
    renderResults(match);
  });
  newFresh?.addEventListener('click', () => {
    suggEl.classList.add('hidden');
    startAnalysis();
  });
}
async function openHistory() {
  for (const s of SCREENS) {
    const el = $(`screen-${s}`);
    if (el && !el.classList.contains('hidden')) { screenBeforeSecond = s; break; }
  }
  await renderHistoryScreen();
  showScreen('history');
}

function closeHistory() {
  showScreen(screenBeforeSecond || 'idle');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // ── Analysis ──────────────────────────────────────────────────────────────
  $('analyze-btn')        ?.addEventListener('click', startAnalysis);
  $('reanalyze-btn')      ?.addEventListener('click', startAnalysis);
  $('no-links-retry-btn') ?.addEventListener('click', startAnalysis);
  $('error-retry-btn')    ?.addEventListener('click', startAnalysis);

  // ── Setup screen ──────────────────────────────────────────────────────────
  $('setup-save-btn') ?.addEventListener('click', saveSetupKey);
  $('setup-key-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveSetupKey(); });

  // ── Settings: open from header gear + error screen button ─────────────────
  $('open-settings')     ?.addEventListener('click', openSettings);
  $('error-settings-btn')?.addEventListener('click', openSettings);

  // Settings: back button
  $('settings-back-btn')?.addEventListener('click', closeSettings);

  // Settings: save key
  $('settings-save-btn')  ?.addEventListener('click', settingsSaveKey);
  $('settings-key-input') ?.addEventListener('keydown', e => { if (e.key === 'Enter') settingsSaveKey(); });

  // Settings: remove key
  $('settings-remove-btn')?.addEventListener('click', settingsRemoveKey);

  // Settings: toggle password visibility
  $('settings-toggle-vis')?.addEventListener('click', () => {
    const inp = $('settings-key-input');
    const eye = $('settings-eye-icon');
    if (!inp) return;
    const isHidden = inp.type === 'password';
    inp.type = isHidden ? 'text' : 'password';
    if (eye) {
      eye.innerHTML = isHidden
        // eye-off: slash through eye
        ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
        // eye: open
        : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
    }
  });

  // ── History ───────────────────────────────────────────────────────────────
  $('history-btn')     ?.addEventListener('click', openHistory);
  $('history-back-btn')?.addEventListener('click', closeHistory);
  $('history-clear-btn')?.addEventListener('click', async () => {
    if (!confirm('Clear all saved history? This cannot be undone.')) return;
    await historyClearAll();
    await renderHistoryScreen();
  });

  // ── New scan button (in results hero) ─────────────────────────────────────
  $('new-scan-btn')?.addEventListener('click', startAnalysis);

  // ── Chat: send button + Enter key ─────────────────────────────────────────
  $('chat-send-btn')?.addEventListener('click', () => {
    const q = ($('chat-input')?.value || '').trim();
    if (q) sendChatQuestion(q);
  });
  $('chat-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const q = ($('chat-input')?.value || '').trim();
      if (q) sendChatQuestion(q);
    }
  });

  // ── Chat: suggestion chips ────────────────────────────────────────────────
  document.querySelectorAll('.chat-suggestion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.q;
      if (q) sendChatQuestion(q);
    });
  });

  init();
});
