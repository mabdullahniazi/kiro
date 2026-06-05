/**
 * TermsLens Popup Script
 * Manages UI state and communicates with the background service worker.
 */

// ---- Screen management ----
const SCREENS = ['setup', 'loading', 'no-links', 'error', 'results', 'default'];

function showScreen(name) {
  for (const id of SCREENS) {
    const el = document.getElementById(`screen-${id}`);
    if (el) {
      el.classList.remove('active');
      el.style.display = 'none';
    }
  }
  const target = document.getElementById(`screen-${name}`);
  if (target) {
    target.style.display = 'block';
    target.classList.add('active');
  }
}

// ---- Loading messages ----
const LOADING_STEPS = [
  'Scanning for policy links...',
  'Fetching policy documents...',
  'Extracting legal text...',
  'Sending to Gemini AI...',
  'Analyzing policies...',
  'Almost there...',
];

let loadingInterval = null;

function startLoadingAnimation() {
  let i = 0;
  const msgEl = document.getElementById('loading-message');
  if (msgEl) msgEl.textContent = LOADING_STEPS[0];
  loadingInterval = setInterval(() => {
    i = (i + 1) % LOADING_STEPS.length;
    if (msgEl) msgEl.textContent = LOADING_STEPS[i];
  }, 2500);
}

function stopLoadingAnimation() {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
}

// ---- Score helpers ----
function getScoreClass(score) {
  if (score === 10) return 'score-excellent';
  if (score >= 7)  return 'score-low';
  if (score >= 4)  return 'score-moderate';
  return 'score-high';
}

// ---- Render results ----
function renderResults(data) {
  const { domain, analysisResult, scoreData, redFlags, failures } = data;

  // Domain
  document.getElementById('result-domain').textContent = domain || 'Unknown site';

  // Score
  const scoreClass = getScoreClass(scoreData.score);
  const scoreRing = document.getElementById('score-ring');
  scoreRing.className = `score-ring ${scoreClass}`;
  document.getElementById('score-number').textContent = scoreData.score;

  const scoreLabelEl = document.getElementById('score-label');
  scoreLabelEl.textContent = scoreData.label;
  scoreLabelEl.className = `score-label ${scoreClass}`;

  // Extraction failures
  const warningsEl = document.getElementById('fetch-warnings');
  if (failures && failures.length > 0) {
    warningsEl.classList.remove('hidden');
    warningsEl.innerHTML = failures.map(f =>
      `⚠️ Could not fetch: <strong>${f.url}</strong> — ${f.reason}`
    ).join('<br>');
  } else {
    warningsEl.classList.add('hidden');
  }

  // Summary
  document.getElementById('result-summary').textContent =
    analysisResult.summary || 'No summary available.';

  // Data collected
  renderTagList('result-data-collected', analysisResult.dataCollected, 'None detected');

  // Data shared
  renderTagList('result-data-shared', analysisResult.dataSharedWith, 'None detected');

  // Red flags
  renderRedFlags(redFlags);

  // User rights
  renderRightsList('result-user-rights', analysisResult.userRights);

  // Recommendation
  document.getElementById('result-recommendation').textContent =
    analysisResult.recommendation || 'No recommendation available.';

  showScreen('results');
}

function renderTagList(elementId, items, emptyText) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = '';

  if (!items || items.length === 0) {
    el.innerHTML = `<li class="placeholder-text">${emptyText}</li>`;
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    el.appendChild(li);
  }
}

function renderRedFlags(redFlags) {
  const el = document.getElementById('result-red-flags');
  if (!el) return;
  el.innerHTML = '';

  if (!redFlags || redFlags.length === 0) {
    el.innerHTML = '<li class="placeholder-text">No significant red flags identified.</li>';
    return;
  }

  for (const flag of redFlags) {
    const li = document.createElement('li');
    li.className = 'flag-item';
    li.innerHTML = `
      <span class="flag-icon" aria-hidden="true">⚠️</span>
      <div class="flag-content">
        <div class="flag-category">${escapeHtml(flag.category)}</div>
        <div class="flag-description">${escapeHtml(flag.description)}</div>
      </div>
    `;
    el.appendChild(li);
  }
}

function renderRightsList(elementId, rights) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = '';

  if (!rights || rights.length === 0) {
    el.innerHTML = '<li class="placeholder-text">No user rights identified.</li>';
    return;
  }

  for (const right of rights) {
    const li = document.createElement('li');
    li.textContent = right;
    el.appendChild(li);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---- Error handling ----
const ERROR_MESSAGES = {
  NO_API_KEY: 'No API key configured. Please add your Gemini API key in settings.',
  INVALID_KEY: 'Your API key was rejected by Gemini. Please update it in settings.',
  DETECTION_FAILED: 'Could not scan this page for policy links. Make sure the page has fully loaded.',
  EXTRACTION_TIMEOUT: 'Fetching policy pages timed out.',
  EXTRACTION_FAILED: 'Could not extract text from any policy page.',
  ANALYSIS_FAILED: 'AI analysis failed. Please try again.',
  WORKFLOW_TIMEOUT: 'The analysis timed out (15s limit). The site may be slow.',
  NO_ACTIVE_TAB: 'Could not access the active tab.',
  UNEXPECTED_ERROR: 'An unexpected error occurred.',
};

function showError(errorCode, detail) {
  const baseMsg = ERROR_MESSAGES[errorCode] || errorCode || 'An unknown error occurred.';
  const fullMsg = detail ? `${baseMsg}\n\nDetails: ${detail}` : baseMsg;
  document.getElementById('error-message-text').textContent = fullMsg;

  // Show settings button for key-related errors
  const settingsBtn = document.getElementById('error-settings-btn');
  if (errorCode === 'NO_API_KEY' || errorCode === 'INVALID_KEY') {
    settingsBtn.style.display = 'inline-flex';
  } else {
    settingsBtn.style.display = 'none';
  }

  showScreen('error');
}

// ---- Main analysis trigger ----
function startAnalysis() {
  showScreen('loading');
  startLoadingAnimation();

  chrome.runtime.sendMessage({ action: 'START_ANALYSIS' }, (response) => {
    stopLoadingAnimation();

    if (chrome.runtime.lastError) {
      showError('UNEXPECTED_ERROR', chrome.runtime.lastError.message);
      return;
    }

    if (!response) {
      showError('UNEXPECTED_ERROR', 'No response from background script.');
      return;
    }

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
  });
}

// ---- API Key check on open ----
function checkApiKeyOnLoad() {
  chrome.runtime.sendMessage({ action: 'CHECK_API_KEY' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      showScreen('default');
      return;
    }
    if (!response.hasKey) {
      showScreen('setup');
    } else {
      showScreen('default');
    }
  });
}

// ---- Event Listeners ----
document.addEventListener('DOMContentLoaded', () => {
  checkApiKeyOnLoad();

  // Analyze button (default screen)
  document.getElementById('analyze-btn')?.addEventListener('click', startAnalysis);

  // Retry buttons
  document.getElementById('retry-btn')?.addEventListener('click', startAnalysis);
  document.getElementById('error-retry-btn')?.addEventListener('click', startAnalysis);
  document.getElementById('analyze-again-btn')?.addEventListener('click', startAnalysis);

  // Error settings button
  document.getElementById('error-settings-btn')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage?.() || chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  });

  // Open options from header
  document.getElementById('open-options')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage?.() || chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  });

  // Inline API key save (setup screen)
  document.getElementById('inline-save-key')?.addEventListener('click', saveInlineApiKey);
  document.getElementById('inline-api-key')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveInlineApiKey();
  });
});

function saveInlineApiKey() {
  const input = document.getElementById('inline-api-key');
  const errorEl = document.getElementById('setup-error');
  const key = input?.value?.trim();

  errorEl.classList.add('hidden');
  errorEl.textContent = '';

  if (!key) {
    errorEl.textContent = 'Please enter an API key.';
    errorEl.classList.remove('hidden');
    return;
  }

  if (key.length > 200) {
    errorEl.textContent = 'API key is too long (max 200 characters).';
    errorEl.classList.remove('hidden');
    return;
  }

  chrome.runtime.sendMessage({ action: 'SAVE_API_KEY', apiKey: key }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      errorEl.textContent = 'Failed to save key. Please try again.';
      errorEl.classList.remove('hidden');
      return;
    }
    // Key saved — go to default screen
    input.value = '';
    showScreen('default');
  });
}
