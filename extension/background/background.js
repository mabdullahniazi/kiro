/**
 * TermsLens Background Service Worker
 * Orchestrates the full analysis pipeline.
 * API key is ONLY accessed here — never in content scripts or popup.
 */

import { extractPolicyTexts } from '../services/parser.js';
import { analyzeWithGemini } from '../services/gemini.js';
import { processAnalysis } from '../services/analyzer.js';

const WORKFLOW_TIMEOUT_MS = 15000;

/**
 * Get the stored API key from chrome.storage.local.
 */
async function getApiKey() {
  return new Promise(resolve => {
    chrome.storage.local.get('geminiApiKey', data => {
      resolve(data.geminiApiKey || null);
    });
  });
}

/**
 * Get the active tab.
 */
async function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0] || null);
    });
  });
}

/**
 * Send a message to the content script in a tab.
 */
async function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Main analysis pipeline.
 */
async function runAnalysisPipeline(tab) {
  // Step 1: Check API key
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { success: false, error: 'NO_API_KEY' };
  }

  // Step 2: Detect policy links via content script
  let linksResponse;
  try {
    linksResponse = await sendToContentScript(tab.id, { action: 'DETECT_POLICY_LINKS' });
  } catch (err) {
    // Try injecting the content script if not yet active
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
      linksResponse = await sendToContentScript(tab.id, { action: 'DETECT_POLICY_LINKS' });
    } catch (injectErr) {
      return { success: false, error: 'DETECTION_FAILED', detail: injectErr.message };
    }
  }

  if (!linksResponse?.success) {
    return { success: false, error: 'DETECTION_FAILED', detail: linksResponse?.error };
  }

  const policyLinks = linksResponse.links || [];

  if (policyLinks.length === 0) {
    return { success: true, noLinks: true, domain: new URL(tab.url).hostname };
  }

  // Step 3: Extract policy text
  let extractionResult;
  try {
    extractionResult = await extractPolicyTexts(policyLinks);
  } catch (err) {
    return { success: false, error: 'EXTRACTION_TIMEOUT', detail: err.message };
  }

  const { combinedText, failures } = extractionResult;

  if (!combinedText || combinedText.trim().length === 0) {
    return {
      success: false,
      error: 'EXTRACTION_FAILED',
      detail: 'Could not extract text from any policy page.',
      failures,
    };
  }

  // Step 4: Analyze with Gemini
  const { result: analysisResult, error: geminiError, invalidKey } = await analyzeWithGemini(apiKey, combinedText);

  if (invalidKey) {
    return { success: false, error: 'INVALID_KEY' };
  }

  if (!analysisResult) {
    return { success: false, error: 'ANALYSIS_FAILED', detail: geminiError };
  }

  // Step 5: Process with Analyzer
  const { scoreData, redFlags } = processAnalysis(analysisResult);

  return {
    success: true,
    domain: new URL(tab.url).hostname,
    analysisResult,
    scoreData,
    redFlags,
    failures,
    linksFound: policyLinks,
  };
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_ANALYSIS') {
    const timeout = setTimeout(() => {
      sendResponse({ success: false, error: 'WORKFLOW_TIMEOUT' });
    }, WORKFLOW_TIMEOUT_MS);

    getActiveTab()
      .then(tab => {
        if (!tab) {
          clearTimeout(timeout);
          sendResponse({ success: false, error: 'NO_ACTIVE_TAB' });
          return;
        }
        return runAnalysisPipeline(tab);
      })
      .then(result => {
        if (result) {
          clearTimeout(timeout);
          sendResponse(result);
        }
      })
      .catch(err => {
        clearTimeout(timeout);
        sendResponse({ success: false, error: 'UNEXPECTED_ERROR', detail: err.message });
      });

    return true; // Keep message channel open for async response
  }

  if (message.action === 'SAVE_API_KEY') {
    const key = message.apiKey;
    if (!key || typeof key !== 'string' || key.trim().length === 0 || key.trim().length > 200) {
      sendResponse({ success: false, error: 'Invalid API key length' });
      return true;
    }
    chrome.storage.local.set({ geminiApiKey: key.trim() }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'CLEAR_API_KEY') {
    chrome.storage.local.remove('geminiApiKey', () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.action === 'CHECK_API_KEY') {
    getApiKey().then(key => {
      sendResponse({ hasKey: !!key });
    });
    return true;
  }
});
