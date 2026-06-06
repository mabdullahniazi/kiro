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
    modelUsed: geminiDebug?.model || '',   // which model succeeded — used by chat
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

  if (msg.action === 'CHAT_QUESTION') {
    // Run entirely async — keep return true to hold the message port open
    (async () => {
      const { question, context, domain, model } = msg;

      // ── Guardrail ────────────────────────────────────────────────────────
      const BLOCKED = [
        /weather|forecast|temperature/i,
        /recipe|cook|ingredient|meal/i,
        /sport|score|nfl|nba|soccer|football|cricket/i,
        /stock|crypto|bitcoin|ethereum|invest/i,
        /\bnews\b|headline|election|president/i,
        /joke|funny|meme/i,
      ];
      const POLICY_KEYWORDS = /privacy|policy|terms|data|collect|share|store|retain|delete|right|gdpr|ccpa|cookie|track|personal|information|account|user|clause|flag|concern|explain/i;

      const isBlocked      = BLOCKED.some(p => p.test(question));
      const isPolicyRelated = POLICY_KEYWORDS.test(question);

      if (isBlocked || (!isPolicyRelated && question.trim().length > 20)) {
        sendResponse({
          blocked: true,
          message: `I can only answer questions about ${domain || 'this site'}'s privacy policy and terms. Try asking about data collection, sharing, your rights, or what a specific concern means.`,
        });
        return;
      }

      const apiKey = await getApiKey();
      if (!apiKey) {
        sendResponse({ blocked: false, answer: 'No API key configured. Please add it in Settings.' });
        return;
      }

      // Prefer the model that succeeded during the analysis scan
      const MODELS = [
        model || 'gemini-2.0-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
      ].filter((m, i, arr) => arr.indexOf(m) === i);

      // Context is injected once (first message of session); subsequent calls pass null
      const systemPreamble = context
        ? `You are a plain-English legal assistant. The user just saw these analysis results for ${domain || 'a website'}:\n\n${context}\n\nAnswer all questions based only on this policy context. Plain English, no legal jargon, under 150 words. Never discuss unrelated topics.\n\n`
        : `You are a plain-English legal assistant answering questions about ${domain || 'a website'}'s privacy policy. Plain English, under 150 words, policy-relevant only.\n\n`;

      const fullPrompt = `${systemPreamble}User question: "${question}"`;

      for (const tryModel of MODELS) {
        const chatUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(tryModel)}:generateContent`;
        try {
          const ctrl  = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 25000);

          const res = await fetch(`${chatUrl}?key=${apiKey}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              contents: [{ parts: [{ text: fullPrompt }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);

          if (res.status === 401 || res.status === 403) {
            sendResponse({ blocked: false, answer: 'API key rejected. Please update it in Settings.' });
            return;
          }

          if (res.status === 429) {
            blog(`Chat: ${tryModel} quota exceeded, trying next model`);
            continue;
          }

          if (!res.ok) {
            blog(`Chat: ${tryModel} returned HTTP ${res.status}, trying next`);
            continue;
          }

          const data = await res.json();
          const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

          if (!answer) {
            blog(`Chat: ${tryModel} returned empty answer, trying next`);
            continue;
          }

          blog(`Chat answered by ${tryModel}`);
          sendResponse({ blocked: false, answer, model: tryModel });
          return;
        } catch (e) {
          blog(`Chat model ${tryModel} threw: ${e.message}`);
          continue;
        }
      }

      sendResponse({ blocked: false, answer: 'Could not get an answer right now. Please try again.' });
    })();

    return true;  // keep message port open while async work runs
  }
});

blog('Background service worker ready (v1.1 — side panel mode)');
