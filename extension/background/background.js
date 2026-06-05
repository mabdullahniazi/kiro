/**
 * TermsLens Background Service Worker
 * - Opens the side panel when the toolbar icon is clicked
 * - Orchestrates the full analysis pipeline
 * - Full step-by-step debug logging returned to the side panel
 */

import { extractPolicyTexts } from '../services/parser.js';
import { analyzeWithGemini }  from '../services/gemini.js';
import { processAnalysis }    from '../services/analyzer.js';

// ─── Logger ───────────────────────────────────────────────────────────────────
const TAG = '[TermsLens:bg]';
function blog(msg, ...a)  { console.log(TAG, msg, ...a); }
function bwarn(msg, ...a) { console.warn(TAG, '⚠️', msg, ...a); }
function berr(msg, ...a)  { console.error(TAG, '❌', msg, ...a); }

// ─── Open side panel on toolbar click ─────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  blog('Toolbar icon clicked — opening side panel for tab', tab.id, tab.url);
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
    blog('Side panel opened');
  } catch (e) {
    berr('Failed to open side panel:', e.message);
  }
});

// Keep side panel enabled on all tabs
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: true });
  blog('Installed — side panel enabled globally');
});

// ─── Debug log builder ────────────────────────────────────────────────────────
function makeDebugLog() {
  const entries = [];
  const push = (step, status, message, detail = null) => {
    const entry = { step, status, message, detail, ts: Date.now() };
    entries.push(entry);
    const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : status === 'error' ? '❌' : 'ℹ️';
    blog(`[${step}] ${icon} ${message}`, detail ?? '');
    return entry;
  };
  return { entries, push };
}

// ─── Chrome helpers ───────────────────────────────────────────────────────────
async function getApiKey() {
  return new Promise(resolve =>
    chrome.storage.local.get('geminiApiKey', d => resolve((d.geminiApiKey || '').trim() || null))
  );
}

async function getActiveTab() {
  return new Promise(resolve =>
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0] || null))
  );
}

function sendToContentScript(tabId, message, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Content script timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    chrome.tabs.sendMessage(tabId, message, response => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Main pipeline ────────────────────────────────────────────────────────────
async function runAnalysisPipeline(tab) {
  const { push, entries } = makeDebugLog();
  const startTs = Date.now();

  push('init', 'info', `Pipeline started for: ${tab.url}`, { tabId: tab.id });

  // ── STEP 1: API key ────────────────────────────────────────────────────────
  push('api-key', 'info', 'Checking stored Gemini API key…');
  const apiKey = await getApiKey();

  if (!apiKey) {
    push('api-key', 'error', 'No API key in storage — open settings to add one.');
    return { success: false, error: 'NO_API_KEY', debugLog: entries };
  }
  push('api-key', 'ok', `API key present (${apiKey.length} chars)`);

  // ── STEP 2: Detect policy links ────────────────────────────────────────────
  push('detection', 'info', 'Asking content script to scan page for policy links…');
  let contentReply;

  try {
    contentReply = await sendToContentScript(tab.id, { action: 'DETECT_POLICY_LINKS' });
    push('detection', 'ok', 'Content script responded', contentReply);
  } catch (firstErr) {
    push('detection', 'warn', `Content script not ready (${firstErr.message}) — injecting script…`);
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
      push('detection', 'info', 'Script injected — waiting 500ms then retrying…');
      await new Promise(r => setTimeout(r, 500));
      contentReply = await sendToContentScript(tab.id, { action: 'DETECT_POLICY_LINKS' });
      push('detection', 'ok', 'Content script responded after injection', contentReply);
    } catch (injectErr) {
      push('detection', 'error', `Script injection also failed: ${injectErr.message}`);
      return { success: false, error: 'DETECTION_FAILED', detail: injectErr.message, debugLog: entries };
    }
  }

  if (!contentReply?.success) {
    push('detection', 'error', `Content script returned failure: ${contentReply?.error ?? 'no response'}`);
    return { success: false, error: 'DETECTION_FAILED', detail: contentReply?.error, debugLog: entries };
  }

  const linkedPolicies = contentReply.links   || [];
  const selfDoc        = contentReply.selfDoc || null;

  push('detection', 'info',
    `Results — selfDoc: ${selfDoc ? `[${selfDoc.type}] ${selfDoc.text.length} chars` : 'none'}, external links: ${linkedPolicies.length}`,
    {
      selfDoc: selfDoc ? { type: selfDoc.type, url: selfDoc.url, chars: selfDoc.text.length } : null,
      links: linkedPolicies.map(l => `[${l.type}] ${l.url}`)
    }
  );

  if (!selfDoc && linkedPolicies.length === 0) {
    push('detection', 'warn', 'No policy links found and current page is not a policy page.');
    return { success: true, noLinks: true, domain: new URL(tab.url).hostname, debugLog: entries };
  }

  // ── STEP 3: Fetch external policy pages ────────────────────────────────────
  let perDoc   = [];
  let failures = [];

  // Add self-doc first if present
  if (selfDoc) {
    push('extraction', 'ok', `[self] Using current page as [${selfDoc.type}] — ${selfDoc.text.length} chars`);
    perDoc.push({ ...selfDoc, source: 'self', charCount: selfDoc.text.length });
  }

  // Fetch external links (privacy + terms fetched in parallel)
  if (linkedPolicies.length > 0) {
    push('extraction', 'info', `Fetching ${linkedPolicies.length} external policy URL(s) in parallel…`);
    push('extraction', 'info', 'URLs: ' + linkedPolicies.map(l => l.url).join(', '));

    let extractResult;
    try {
      extractResult = await extractPolicyTexts(linkedPolicies, push);
    } catch (extErr) {
      push('extraction', 'error', `Extraction threw: ${extErr.message}`);
      if (perDoc.length === 0) {
        return { success: false, error: 'EXTRACTION_FAILED', detail: extErr.message, debugLog: entries };
      }
    }

    if (extractResult) {
      for (const doc of extractResult.perDoc) {
        push('extraction', 'ok', `✓ [${doc.type}] ${doc.url} — ${doc.charCount} chars`);
        perDoc.push({ ...doc, source: 'fetched' });
      }
      for (const f of extractResult.failures) {
        push('extraction', 'warn', `✗ [${f.type}] ${f.url} — ${f.reason}`);
        failures.push(f);
      }
    }
  }

  push('extraction', 'info', `Extraction complete: ${perDoc.length} doc(s) ready, ${failures.length} failed`);

  if (perDoc.length === 0) {
    push('extraction', 'error', 'No documents extracted — cannot analyse.');
    return { success: false, error: 'EXTRACTION_FAILED', detail: 'All policy fetches failed.', failures, debugLog: entries };
  }

  // ── STEP 4: Build combined prompt text ─────────────────────────────────────
  const MAX_CHARS = 30000;
  const sections = perDoc.map(d => {
    const label = d.type.toUpperCase().replace(/-/g, ' ');
    return `=== ${label} ===\nSource: ${d.url}\n\n${d.text}`;
  });
  let combinedText = sections.join('\n\n' + '─'.repeat(60) + '\n\n');

  if (combinedText.length > MAX_CHARS) {
    push('extraction', 'warn', `Combined text ${combinedText.length} chars — truncating to ${MAX_CHARS}`);
    combinedText = combinedText.slice(0, MAX_CHARS);
  }
  push('extraction', 'ok', `Combined text: ${combinedText.length} chars across ${perDoc.length} doc(s)`);

  // ── STEP 5: Gemini API ──────────────────────────────────────────────────────
  push('gemini', 'info', `Sending to Gemini with model fallbacks — ${combinedText.length} chars…`);
  const geminiStart = Date.now();

  const { result: analysisResult, error: geminiErr, invalidKey, debugInfo: geminiDebug } =
    await analyzeWithGemini(apiKey, combinedText);

  const geminiMs = Date.now() - geminiStart;

  if (geminiDebug) {
    push('gemini', 'info',
      `Gemini HTTP ${geminiDebug.httpStatus ?? '?'}, model ${geminiDebug.model ?? '?'}, attempt ${geminiDebug.attempt ?? '?'}, took ${geminiMs}ms`,
      geminiDebug
    );
  }

  if (invalidKey) {
    push('gemini', 'error', 'Gemini rejected the API key (401/403). Update your key in settings.');
    return { success: false, error: 'INVALID_KEY', debugLog: entries };
  }

  if (!analysisResult) {
    push('gemini', 'error', `Gemini failed after ${geminiMs}ms: ${geminiErr}`);
    return { success: false, error: 'ANALYSIS_FAILED', detail: geminiErr, debugLog: entries };
  }

  push('gemini', 'ok', `Analysis received in ${geminiMs}ms`, {
    aiScore: analysisResult.score,
    redFlags: analysisResult.redFlags?.length,
    dataCollected: analysisResult.dataCollected?.length,
    summaryPreview: (analysisResult.summary || '').slice(0, 80) + '…',
  });

  // ── STEP 6: Score & categorise ─────────────────────────────────────────────
  push('scoring', 'info', 'Computing privacy score and categorising red flags…');
  let scoreData, redFlags;
  try {
    ({ scoreData, redFlags } = processAnalysis(analysisResult));
    push('scoring', 'ok', `Score: ${scoreData.score}/10 — ${scoreData.label}  |  Red flags: ${redFlags.length}`, {
      score: scoreData.score, label: scoreData.label,
      deductions: scoreData.appliedDeductions,
      bonuses: scoreData.appliedBonuses,
    });
  } catch (scoreErr) {
    push('scoring', 'error', `Scoring threw: ${scoreErr.message}`);
    return { success: false, error: 'SCORING_FAILED', detail: scoreErr.message, debugLog: entries };
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  const totalMs = Date.now() - startTs;
  push('done', 'ok', `Pipeline complete in ${totalMs}ms`, {
    domain: new URL(tab.url).hostname,
    docs: perDoc.map(d => ({ type: d.type, source: d.source, chars: d.charCount })),
  });

  return {
    success: true,
    domain: new URL(tab.url).hostname,
    analysisResult,
    scoreData,
    redFlags,
    failures,
    linksFound: perDoc.map(d => ({ type: d.type, url: d.url, source: d.source })),
    debugLog: entries,
    totalMs,
  };
}

// ─── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.action === 'START_ANALYSIS') {
    blog('START_ANALYSIS received');

    const TIMEOUT_MS = 60000;
    let settled = false;
    const guard = setTimeout(() => {
      if (!settled) {
        settled = true;
        berr('Workflow timed out after', TIMEOUT_MS / 1000, 's');
        sendResponse({
          success: false,
          error: 'WORKFLOW_TIMEOUT',
          detail: `Timed out after ${TIMEOUT_MS / 1000}s`,
          debugLog: [],
        });
      }
    }, TIMEOUT_MS);

    getActiveTab()
      .then(tab => {
        if (!tab) throw Object.assign(new Error('No active tab'), { code: 'NO_ACTIVE_TAB' });
        blog('Active tab:', tab.url);
        return runAnalysisPipeline(tab);
      })
      .then(result => {
        if (!settled) {
          settled = true;
          clearTimeout(guard);
          blog('Sending result. success=', result.success);
          sendResponse(result);
        }
      })
      .catch(e => {
        if (!settled) {
          settled = true;
          clearTimeout(guard);
          berr('Uncaught pipeline error:', e.message);
          sendResponse({ success: false, error: e.code || 'UNEXPECTED_ERROR', detail: e.message, debugLog: [] });
        }
      });

    return true;
  }

  if (msg.action === 'SAVE_API_KEY') {
    const key = (msg.apiKey || '').trim();
    if (!key || key.length > 200) {
      sendResponse({ success: false, error: 'API key must be 1–200 characters.' });
      return true;
    }
    chrome.storage.local.set({ geminiApiKey: key }, () => {
      blog('API key saved');
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.action === 'CLEAR_API_KEY') {
    chrome.storage.local.remove('geminiApiKey', () => {
      blog('API key cleared');
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.action === 'CHECK_API_KEY') {
    getApiKey().then(key => sendResponse({ hasKey: !!key }));
    return true;
  }
});

blog('Background service worker ready (v1.1 — side panel mode)');
