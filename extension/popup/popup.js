/**
 * TermsLens Popup Script
 * Full debug logging panel + live step progress during analysis.
 */

// ─── Screen manager ────────────────────────────────────────────────────────────
const SCREENS = ['setup','loading','no-links','error','results','default'];

function showScreen(name) {
  for (const id of SCREENS) {
    const el = document.getElementById(`screen-${id}`);
    if (!el) continue;
    el.style.display = 'none';
    el.classList.remove('active');
  }
  const t = document.getElementById(`screen-${name}`);
  if (t) { t.style.display = 'block'; t.classList.add('active'); }
}

// ─── Debug log panel ───────────────────────────────────────────────────────────
let _debugEntries = [];

function renderDebugEntry(entry) {
  const icon = entry.status === 'ok' ? '✅'
             : entry.status === 'warn' ? '⚠️'
             : entry.status === 'error' ? '❌'
             : 'ℹ️';
  const div = document.createElement('div');
  div.className = `debug-entry debug-${entry.status}`;

  const elapsed = entry.ts ? `+${entry.ts - (_debugEntries[0]?.ts ?? entry.ts)}ms` : '';

  div.innerHTML = `
    <span class="debug-icon">${icon}</span>
    <span class="debug-step">[${entry.step}]</span>
    <span class="debug-msg">${escapeHtml(entry.message)}</span>
    <span class="debug-time">${elapsed}</span>
    ${entry.detail ? `<pre class="debug-detail">${escapeHtml(
        typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail, null, 2)
      )}</pre>` : ''}
  `;
  return div;
}

function updateDebugPanel(entries) {
  _debugEntries = entries || [];
  const container = document.getElementById('debug-entries');
  if (!container) return;
  container.innerHTML = '';
  for (const e of _debugEntries) container.appendChild(renderDebugEntry(e));
  container.scrollTop = container.scrollHeight;
}

function appendDebugEntry(entry) {
  _debugEntries.push(entry);
  const container = document.getElementById('debug-entries');
  if (!container) return;
  container.appendChild(renderDebugEntry(entry));
  container.scrollTop = container.scrollHeight;
}

// ─── Live step progress (shown during loading) ────────────────────────────────
const STEP_LABELS = {
  'api-key':    '🔑 Checking API key',
  'detection':  '🔎 Detecting policy links',
  'extraction': '📥 Fetching policy text',
  'gemini':     '🤖 Analyzing with Gemini AI',
  'scoring':    '📊 Computing privacy score',
  'done':       '✅ Complete',
};

function updateLiveStep(step, status, message) {
  const container = document.getElementById('live-steps');
  if (!container) return;

  // Find or create row for this step
  let row = container.querySelector(`[data-step="${step}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'live-step';
    row.dataset.step = step;
    container.appendChild(row);
  }

  const icon = status === 'ok' ? '✅' : status === 'error' ? '❌' : status === 'warn' ? '⚠️' : '⏳';
  const label = STEP_LABELS[step] || step;
  row.innerHTML = `<span class="ls-icon">${icon}</span><span class="ls-label">${label}</span><span class="ls-msg">${escapeHtml(message.slice(0, 60))}</span>`;
  row.className = `live-step live-step-${status}`;
}

// ─── Score ─────────────────────────────────────────────────────────────────────
function scoreClass(s) {
  if (s === 10) return 'score-excellent';
  if (s >= 7)  return 'score-low';
  if (s >= 4)  return 'score-moderate';
  return 'score-high';
}

// ─── Render results ────────────────────────────────────────────────────────────
function renderResults(data) {
  const { domain, analysisResult, scoreData, redFlags, failures, linksFound, totalMs } = data;

  document.getElementById('result-domain').textContent = domain || window.location.hostname;

  const sc = scoreClass(scoreData.score);
  const ring = document.getElementById('score-ring');
  ring.className = `score-ring ${sc}`;
  document.getElementById('score-number').textContent = scoreData.score;
  const lbl = document.getElementById('score-label');
  lbl.textContent = scoreData.label;
  lbl.className   = `score-label ${sc}`;

  // Sources row
  const sourcesRow = document.getElementById('sources-row');
  if (linksFound && linksFound.length > 0) {
    sourcesRow.classList.remove('hidden');
    sourcesRow.innerHTML = 'Analyzed: ' + linksFound.map(l =>
      `<span class="source-tag source-${l.source}">${l.type.replace(/-/g,' ')} (${l.source})</span>`
    ).join(' ');
  }

  // Fetch warnings
  const warn = document.getElementById('fetch-warnings');
  if (failures && failures.length > 0) {
    warn.classList.remove('hidden');
    warn.innerHTML = failures.map(f =>
      `⚠️ <strong>[${f.type}]</strong> ${escapeHtml(f.url)} — ${escapeHtml(f.reason)}`
    ).join('<br>');
  } else {
    warn.classList.add('hidden');
  }

  document.getElementById('result-summary').textContent = analysisResult.summary || 'No summary.';
  renderTagList('result-data-collected', analysisResult.dataCollected,  'None detected');
  renderTagList('result-data-shared',    analysisResult.dataSharedWith, 'None detected');
  renderRedFlags(redFlags);
  renderRightsList('result-user-rights', analysisResult.userRights);
  document.getElementById('result-recommendation').textContent = analysisResult.recommendation || '';

  showScreen('results');
}

function renderTagList(id, items, empty) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  if (!items || items.length === 0) {
    el.innerHTML = `<li class="placeholder-text">${empty}</li>`;
    return;
  }
  items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    el.appendChild(li);
  });
}

function renderRedFlags(flags) {
  const el = document.getElementById('result-red-flags');
  if (!el) return;
  el.innerHTML = '';
  if (!flags || flags.length === 0) {
    el.innerHTML = '<li class="placeholder-text">No significant red flags identified.</li>';
    return;
  }
  flags.forEach(f => {
    const li = document.createElement('li');
    li.className = 'flag-item';
    li.innerHTML = `
      <span class="flag-icon" aria-hidden="true">⚠️</span>
      <div class="flag-content">
        <div class="flag-category">${escapeHtml(f.category)}</div>
        <div class="flag-description">${escapeHtml(f.description)}</div>
      </div>`;
    el.appendChild(li);
  });
}

function renderRightsList(id, rights) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '';
  if (!rights || rights.length === 0) {
    el.innerHTML = '<li class="placeholder-text">No user rights identified.</li>';
    return;
  }
  rights.forEach(r => {
    const li = document.createElement('li');
    li.textContent = r;
    el.appendChild(li);
  });
}

// ─── Error screen ──────────────────────────────────────────────────────────────
const ERROR_MESSAGES = {
  NO_API_KEY:        'No API key configured. Open Settings and paste your Gemini API key.',
  INVALID_KEY:       'Gemini rejected your API key (401/403). Please update it in Settings.',
  DETECTION_FAILED:  'Could not scan this page for policy links.',
  EXTRACTION_FAILED: 'Could not extract text from any policy page.',
  ANALYSIS_FAILED:   'Gemini AI analysis failed.',
  SCORING_FAILED:    'Privacy score calculation failed.',
  WORKFLOW_TIMEOUT:  'Pipeline timed out (60s). The site or Gemini may be slow.',
  NO_ACTIVE_TAB:     'Could not access the active tab.',
  UNEXPECTED_ERROR:  'An unexpected error occurred.',
};

function showError(code, detail) {
  const base  = ERROR_MESSAGES[code] || code || 'Unknown error';
  const full  = detail ? `${base}\n\nDetail: ${detail}` : base;
  const preEl = document.getElementById('error-message-text');
  if (preEl) preEl.textContent = full;

  const settBtn = document.getElementById('error-settings-btn');
  if (settBtn) settBtn.style.display = (code === 'NO_API_KEY' || code === 'INVALID_KEY') ? 'inline-flex' : 'none';

  showScreen('error');
}

// ─── Live log forwarding during analysis ──────────────────────────────────────
// We poll for status updates via the debugLog array returned at end of pipeline.
// Meanwhile we animate step labels from the loading-message cycling.
let loadingInterval = null;
const LOADING_MSGS = [
  'Scanning for policy links…',
  'Fetching policy documents…',
  'Extracting legal text…',
  'Sending to Gemini AI…',
  'Analyzing policies…',
  'Almost there…',
];

function startLoadingUI() {
  let i = 0;
  const el = document.getElementById('loading-message');
  if (el) el.textContent = LOADING_MSGS[0];
  loadingInterval = setInterval(() => {
    i = (i + 1) % LOADING_MSGS.length;
    if (el) el.textContent = LOADING_MSGS[i];
  }, 2500);

  // Clear live steps
  const ls = document.getElementById('live-steps');
  if (ls) ls.innerHTML = '';
}

function stopLoadingUI() {
  clearInterval(loadingInterval);
  loadingInterval = null;
}

// ─── Main analysis ─────────────────────────────────────────────────────────────
function startAnalysis() {
  // Clear old debug log
  _debugEntries = [];
  updateDebugPanel([]);

  showScreen('loading');
  startLoadingUI();

  chrome.runtime.sendMessage({ action: 'START_ANALYSIS' }, (response) => {
    stopLoadingUI();

    if (chrome.runtime.lastError) {
      appendDebugEntry({ step: 'chrome', status: 'error', message: chrome.runtime.lastError.message, ts: Date.now() });
      showError('UNEXPECTED_ERROR', chrome.runtime.lastError.message);
      return;
    }

    if (!response) {
      appendDebugEntry({ step: 'chrome', status: 'error', message: 'No response from background script', ts: Date.now() });
      showError('UNEXPECTED_ERROR', 'Background script did not respond.');
      return;
    }

    // Populate debug panel with all log entries from the pipeline
    if (response.debugLog && response.debugLog.length > 0) {
      updateDebugPanel(response.debugLog);
      // Mirror step statuses to live-steps panel (even though loading is done)
      for (const e of response.debugLog) updateLiveStep(e.step, e.status, e.message);
    }

    if (!response.success) {
      if (response.error === 'NO_API_KEY') { showScreen('setup'); return; }
      showError(response.error, response.detail);
      return;
    }

    if (response.noLinks) { showScreen('no-links'); return; }

    renderResults(response);
  });
}

// ─── API key check on open ─────────────────────────────────────────────────────
function checkKeyOnOpen() {
  chrome.runtime.sendMessage({ action: 'CHECK_API_KEY' }, (res) => {
    if (chrome.runtime.lastError || !res) { showScreen('default'); return; }
    showScreen(res.hasKey ? 'default' : 'setup');
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ─── Event wiring ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkKeyOnOpen();

  document.getElementById('analyze-btn')      ?.addEventListener('click', startAnalysis);
  document.getElementById('retry-btn')        ?.addEventListener('click', startAnalysis);
  document.getElementById('error-retry-btn')  ?.addEventListener('click', startAnalysis);
  document.getElementById('analyze-again-btn')?.addEventListener('click', startAnalysis);

  document.getElementById('error-settings-btn')?.addEventListener('click', openOptions);
  document.getElementById('open-options')      ?.addEventListener('click', e => { e.preventDefault(); openOptions(); });

  // Debug panel toggle
  document.getElementById('toggle-debug')?.addEventListener('click', () => {
    const panel = document.getElementById('debug-panel');
    panel?.classList.toggle('hidden');
  });

  // Copy debug log
  document.getElementById('copy-debug')?.addEventListener('click', () => {
    const text = _debugEntries.map(e => {
      const icon = e.status === 'ok' ? '✅' : e.status === 'warn' ? '⚠️' : e.status === 'error' ? '❌' : 'ℹ️';
      const detail = e.detail ? '\n  ' + (typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail)) : '';
      return `${icon} [${e.step}] ${e.message}${detail}`;
    }).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copy-debug');
      if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 2000); }
    });
  });

  // Inline API key save
  document.getElementById('inline-save-key')?.addEventListener('click', saveInlineKey);
  document.getElementById('inline-api-key') ?.addEventListener('keydown', e => { if (e.key === 'Enter') saveInlineKey(); });
});

function openOptions() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  }
}

function saveInlineKey() {
  const input = document.getElementById('inline-api-key');
  const errEl = document.getElementById('setup-error');
  const key   = input?.value?.trim();

  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (!key) {
    errEl.textContent = 'Please enter an API key.';
    errEl.classList.remove('hidden');
    return;
  }
  if (key.length > 200) {
    errEl.textContent = 'Key too long (max 200 chars).';
    errEl.classList.remove('hidden');
    return;
  }

  chrome.runtime.sendMessage({ action: 'SAVE_API_KEY', apiKey: key }, (res) => {
    if (chrome.runtime.lastError || !res?.success) {
      errEl.textContent = 'Failed to save key. Try again.';
      errEl.classList.remove('hidden');
      return;
    }
    input.value = '';
    showScreen('default');
  });
}
