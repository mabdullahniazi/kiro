/**
 * TermsLens Options — Settings page logic
 */

const input      = document.getElementById('api-key-input');
const saveBtn    = document.getElementById('save-btn');
const clearBtn   = document.getElementById('clear-btn');
const toggleBtn  = document.getElementById('toggle-visibility');
const feedbackEl = document.getElementById('feedback');
const statusDot  = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// ─── Status helpers ────────────────────────────────────────────────────
function setStatus(hasKey) {
  statusDot.className  = `status-dot ${hasKey ? 'active' : 'inactive'}`;
  statusText.textContent = hasKey ? '✓ API key is configured' : 'No API key configured';
}

function showFeedback(msg, type /* 'success' | 'error' */) {
  feedbackEl.textContent = msg;
  feedbackEl.className = `feedback ${type}`;
  feedbackEl.classList.remove('hidden');
  clearTimeout(showFeedback._timer);
  showFeedback._timer = setTimeout(() => feedbackEl.classList.add('hidden'), 4500);
}

// ─── Init ──────────────────────────────────────────────────────────────
chrome.storage.local.get('geminiApiKey', d => setStatus(!!d.geminiApiKey));

// ─── Toggle visibility ─────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  input.type = input.type === 'password' ? 'text' : 'password';
  toggleBtn.textContent = input.type === 'password' ? '👁' : '🙈';
});

// ─── Save ──────────────────────────────────────────────────────────────
function doSave() {
  const key = input.value.trim();
  if (!key) { showFeedback('Please enter an API key.', 'error'); return; }
  if (key.length > 200) { showFeedback('Key too long (max 200 chars).', 'error'); return; }

  chrome.storage.local.set({ geminiApiKey: key }, () => {
    if (chrome.runtime.lastError) {
      showFeedback('Save failed: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    showFeedback('✓ API key saved.', 'success');
    setStatus(true);
    input.value = '';
    input.type  = 'password';
    toggleBtn.textContent = '👁';
  });
}

saveBtn.addEventListener('click', doSave);
input.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });

// ─── Clear ─────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (!confirm('Remove stored API key? You will need to re-enter it to use TermsLens.')) return;

  chrome.storage.local.remove('geminiApiKey', () => {
    if (chrome.runtime.lastError) {
      showFeedback('Remove failed: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    showFeedback('API key removed.', 'success');
    setStatus(false);
    input.value = '';
  });
});
