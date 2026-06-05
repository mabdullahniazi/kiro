/**
 * TermsLens Options Page Script
 */

const apiKeyInput = document.getElementById('api-key-input');
const saveBtn = document.getElementById('save-btn');
const clearBtn = document.getElementById('clear-btn');
const toggleBtn = document.getElementById('toggle-visibility');
const feedbackEl = document.getElementById('feedback');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

function showFeedback(message, type) {
  feedbackEl.textContent = message;
  feedbackEl.className = `feedback ${type}`;
  feedbackEl.classList.remove('hidden');
  setTimeout(() => {
    feedbackEl.classList.add('hidden');
  }, 4000);
}

function updateKeyStatus(hasKey) {
  if (hasKey) {
    statusDot.className = 'status-dot active';
    statusText.textContent = 'API key is configured';
  } else {
    statusDot.className = 'status-dot inactive';
    statusText.textContent = 'No API key configured';
  }
}

// Load current status
chrome.storage.local.get('geminiApiKey', (data) => {
  updateKeyStatus(!!data.geminiApiKey);
});

// Toggle password visibility
toggleBtn.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

// Save key
saveBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    showFeedback('Please enter an API key.', 'error');
    return;
  }

  if (key.length > 200) {
    showFeedback('API key is too long (max 200 characters).', 'error');
    return;
  }

  chrome.storage.local.set({ geminiApiKey: key }, () => {
    if (chrome.runtime.lastError) {
      showFeedback('Failed to save key: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    showFeedback('✓ API key saved successfully!', 'success');
    updateKeyStatus(true);
    apiKeyInput.value = '';
    apiKeyInput.type = 'password';
  });
});

// Clear key
clearBtn.addEventListener('click', () => {
  if (!confirm('Remove your stored API key? You will need to re-enter it to use TermsLens.')) {
    return;
  }

  chrome.storage.local.remove('geminiApiKey', () => {
    if (chrome.runtime.lastError) {
      showFeedback('Failed to remove key: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    showFeedback('API key removed.', 'success');
    updateKeyStatus(false);
    apiKeyInput.value = '';
  });
});

// Allow Enter key to save
apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});
