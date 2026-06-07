/**
 * TermsLens Gemini Client
 * Full verbose logging of every request/response/validation step.
 */

const TAG   = '[TermsLens:gemini]';
const glog  = (...a) => console.log(TAG, ...a);
const gwarn = (...a) => console.warn(TAG, '⚠️', ...a);
// const gerr  = (...a) => console.error(TAG, '❌', ...a);

const GEMINI_API_BASE   = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS     = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];
const REQUEST_TIMEOUT   = 30000;   // 30 s — Gemini can be slow on long text
const MAX_INPUT_CHARS   = 28000;   // stay within Gemini token limits
const RETRY_DELAY_MS    = 3000;
const MAX_ATTEMPTS_PER_MODEL = 2;

function buildGeminiUrl(model) {
  return `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────
function buildPrompt(policyText) {
  return `You are a privacy-law analyst helping everyday people understand legal policies. Read the policy text and reply with ONLY a valid JSON object — no markdown, no code fences, no explanation.

Required JSON schema (ALL fields mandatory):
{
  "summaryPoints": [
    "What the service does with your personal data day-to-day (be specific)",
    "Whether they sell or share data with advertisers or third parties for profit",
    "How long they keep your data, and what happens when you delete your account",
    "Whether they track you across other websites or apps (cookies, pixels, etc)",
    "Any automatic subscription renewals, billing terms, or cancellation restrictions",
    "Whether they can change these terms without telling you first",
    "Any limits on what you can do or post, and what happens if you break the rules"
  ],
  "dataCollected":  ["specific data types listed in the policy, e.g. 'Email address', 'IP address', 'Browsing history', 'Payment card details', 'Location data'"],
  "dataSharedWith": ["specific third parties or categories named in the policy, e.g. 'Google Analytics', 'Advertising partners', 'Payment processors', 'Law enforcement'"],
  "redFlags":       ["each entry must start with 'They ' and describe a specific concerning practice found in the policy, e.g. 'They can share your browsing data with advertising networks without asking you', 'They keep your data even after you delete your account'"],
  "userRights":     ["specific rights the user has, e.g. 'You can request deletion of your personal data', 'You can download your data', 'You can opt out of targeted advertising'"],
  "score":          7,
  "recommendation": "One direct sentence — tell the user whether to use this service and what specific action to take."
}

CRITICAL RULES:
- summaryPoints must have EXACTLY 7 entries, one for each topic listed above. Be specific to THIS policy — no generic sentences.
- score: INTEGER 0–10 only
- All text in plain everyday English — no legal jargon
- Be SPECIFIC — extract actual practices from the policy text, not generic descriptions
- Output ONLY the JSON object

Policy text:
${policyText.slice(0, MAX_INPUT_CHARS)}`.trim();
}

// ─── Validation ───────────────────────────────────────────────────────────────
function validateResult(obj) {
  if (!obj || typeof obj !== 'object') {
    gerr('Validation failed: not an object:', typeof obj);
    return { ok: false, reason: `Expected object, got ${typeof obj}` };
  }

  // Accept either summaryPoints (new) or summary (old) field
  const hasSummary = (Array.isArray(obj.summaryPoints) && obj.summaryPoints.length > 0) ||
                     (typeof obj.summary === 'string' && obj.summary.length > 0);

  const checks = [
    [hasSummary, 'summaryPoints (array) or summary (string) must be present and non-empty'],
    [Array.isArray(obj.dataCollected),
      `dataCollected must be an array (got ${typeof obj.dataCollected})`],
    [Array.isArray(obj.dataSharedWith),
      `dataSharedWith must be an array (got ${typeof obj.dataSharedWith})`],
    [Array.isArray(obj.redFlags),
      `redFlags must be an array (got ${typeof obj.redFlags})`],
    [Array.isArray(obj.userRights),
      `userRights must be an array (got ${typeof obj.userRights})`],
    [typeof obj.score === 'number' && Number.isInteger(obj.score) && obj.score >= 0 && obj.score <= 10,
      `score must be integer 0–10 (got ${typeof obj.score}: ${obj.score})`],
    [typeof obj.recommendation === 'string' && obj.recommendation.length > 0,
      `recommendation must be a non-empty string`],
  ];

  const failures = checks.filter(([pass]) => !pass).map(([, msg]) => msg);

  if (failures.length > 0) {
    gerr('Validation failures:', failures);
    return { ok: false, reason: failures.join('; ') };
  }

  // Normalize: always produce a `summary` string from summaryPoints if needed
  if (!obj.summary && Array.isArray(obj.summaryPoints)) {
    obj.summary = obj.summaryPoints.join('\n');
  }

  glog('Validation passed');
  return { ok: true };
}

// ─── Single attempt ───────────────────────────────────────────────────────────
async function callGeminiOnce(apiKey, policyText, model, attempt = 1) {
  const apiUrl = buildGeminiUrl(model);
  glog(`Attempt ${attempt} on ${model}: sending ${Math.min(policyText.length, MAX_INPUT_CHARS)} chars to Gemini`);

  const ctrl  = new AbortController();
  const timer = setTimeout(() => {
    gwarn(`Request timeout (${REQUEST_TIMEOUT}ms) on ${model}, attempt ${attempt}`);
    ctrl.abort();
  }, REQUEST_TIMEOUT);

  const body = {
    contents: [{ parts: [{ text: buildPrompt(policyText) }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  };

  let httpStatus = null;
  try {
    glog(`POST ${apiUrl} (${model}, attempt ${attempt})`);
    const res = await fetch(`${apiUrl}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
    clearTimeout(timer);
    httpStatus = res.status;
    glog(`HTTP ${res.status} ${res.statusText} (${model}, attempt ${attempt})`);

    // ── Auth errors ──────────────────────────────────────────────────────────
    if (res.status === 401 || res.status === 403) {
      const errBody = await res.text().catch(() => '');
      gerr(`Auth error ${res.status}:`, errBody.slice(0, 200));
      return { result: null, error: `${model} auth error ${res.status}: ${errBody.slice(0,100)}`, status: res.status, invalidKey: true, retryable: false, model, attempt, httpStatus };
    }

    // ── Other HTTP errors ────────────────────────────────────────────────────
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      gerr(`Gemini API error ${res.status}:`, errBody.slice(0, 300));
      return { result: null, error: `${model} HTTP ${res.status}: ${errBody.slice(0,150)}`, status: res.status, retryable: isRetryableStatus(res.status), model, attempt, httpStatus };
    }

    // ── Parse JSON wrapper ───────────────────────────────────────────────────
    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      gerr('Failed to parse Gemini wrapper JSON:', parseErr.message);
      return { result: null, error: `${model} JSON parse error on Gemini response: ${parseErr.message}`, retryable: false, model, attempt, httpStatus };
    }

    glog('Gemini response structure keys:', Object.keys(data));

    // ── Check for content filters / empty candidates ─────────────────────────
    if (!data.candidates || data.candidates.length === 0) {
      const promptFeedback = JSON.stringify(data.promptFeedback ?? {});
      gerr('No candidates in Gemini response. promptFeedback:', promptFeedback);
      return { result: null, error: `${model} returned no candidates. promptFeedback: ${promptFeedback}`, retryable: false, model, attempt, httpStatus };
    }

    const candidate = data.candidates[0];
    glog('Finish reason:', candidate.finishReason);

    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
      gwarn(`Unexpected finishReason: ${candidate.finishReason}`);
    }

    const rawText = candidate?.content?.parts?.[0]?.text;
    if (!rawText) {
      gerr('No text in candidate parts. Candidate:', JSON.stringify(candidate).slice(0, 200));
      return { result: null, error: `${model} returned empty text content`, retryable: false, model, attempt, httpStatus };
    }

    glog(`Raw text from Gemini (first 200 chars): ${rawText.slice(0, 200)}`);

    // ── Strip code fences ────────────────────────────────────────────────────
    let jsonStr = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    // Sometimes Gemini wraps with extra text before/after JSON
    // Find the outermost { ... } block
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace  = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      if (firstBrace > 0 || lastBrace < jsonStr.length - 1) {
        gwarn(`Trimming non-JSON prefix/suffix: ${firstBrace} chars before, ${jsonStr.length - lastBrace - 1} chars after`);
        jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
      }
    }

    glog(`JSON string to parse (first 200): ${jsonStr.slice(0, 200)}`);

    // ── Parse inner JSON ─────────────────────────────────────────────────────
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (jsonErr) {
      gerr(`JSON.parse failed: ${jsonErr.message}`);
      gerr(`Failing JSON string: ${jsonStr.slice(0, 400)}`);
      return { result: null, error: `Gemini returned invalid JSON: ${jsonErr.message} — preview: ${jsonStr.slice(0,80)}`, attempt, httpStatus };
    }

    // ── Validate schema ──────────────────────────────────────────────────────
    const validation = validateResult(parsed);
    if (!validation.ok) {
      gerr(`Schema validation failed: ${validation.reason}`);
      return { result: null, error: `Schema validation failed: ${validation.reason}`, attempt, httpStatus };
    }

    glog('✅ Result OK:', { score: parsed.score, redFlags: parsed.redFlags.length, dataCollected: parsed.dataCollected.length });
    return { result: parsed, error: null, attempt, httpStatus, invalidKey: false };

  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      gerr(`Attempt ${attempt} aborted (timeout)`);
      return { result: null, error: `${model} request timed out after ${REQUEST_TIMEOUT / 1000}s`, retryable: true, model, attempt, httpStatus };
    }
    gerr(`Attempt ${attempt} threw:`, e.message);
    return { result: null, error: `${model}: ${e.message}`, retryable: true, model, attempt, httpStatus };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Analyze policy text with Gemini. Retries once on non-auth failure.
 * Returns { result, error, invalidKey, debugInfo }
 */
async function analyzeWithGeminiSingleModel(apiKey, policyText) {
  glog(`analyzeWithGemini called. Text length: ${policyText.length}`);

  // Attempt 1
  const a1 = await callGeminiOnce(apiKey, policyText, GEMINI_MODELS[0], 1);
  if (a1.result) {
    return { result: a1.result, error: null, invalidKey: false, debugInfo: { attempt: 1, httpStatus: a1.httpStatus } };
  }

  // Auth failure — no retry
  if (a1.invalidKey) {
    return { result: null, error: a1.error, invalidKey: true, debugInfo: { attempt: 1, httpStatus: a1.httpStatus } };
  }

  // Attempt 2 after delay
  gwarn(`Attempt 1 failed (${a1.error}) — retrying in ${RETRY_DELAY_MS}ms…`);
  await new Promise(r => setTimeout(r, RETRY_DELAY_MS));

  const a2 = await callGeminiOnce(apiKey, policyText, GEMINI_MODELS[0], 2);
  if (a2.result) {
    return { result: a2.result, error: null, invalidKey: false, debugInfo: { attempt: 2, httpStatus: a2.httpStatus } };
  }

  gerr(`Both attempts failed. Attempt1: ${a1.error} | Attempt2: ${a2.error}`);
  return {
    result:    null,
    error:     `Attempt 1: ${a1.error} | Attempt 2: ${a2.error}`,
    invalidKey: false,
    debugInfo: { attempt: 2, httpStatus: a2.httpStatus, attempt1Error: a1.error, attempt2Error: a2.error },
  };
}

/**
 * Analyze policy text with Gemini.
 * Tries multiple models, and retries transient failures once per model.
 * A 429 quota response immediately falls back to the next model.
 * Returns { result, error, invalidKey, debugInfo }
 */
async function analyzeWithGemini(apiKey, policyText) {
  glog(`analyzeWithGemini called. Text length: ${policyText.length}`);
  glog(`Model fallback order: ${GEMINI_MODELS.join(' -> ')}`);

  const attempts = [];

  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      const response = await callGeminiOnce(apiKey, policyText, model, attempt);
      attempts.push({
        model,
        attempt,
        httpStatus: response.httpStatus ?? null,
        error: response.error ?? null,
      });

      if (response.result) {
        return {
          result: response.result,
          error: null,
          invalidKey: false,
          debugInfo: { model, attempt, httpStatus: response.httpStatus, attempts },
        };
      }

      if (response.invalidKey) {
        return {
          result: null,
          error: response.error,
          invalidKey: true,
          debugInfo: { model, attempt, httpStatus: response.httpStatus, attempts },
        };
      }

      if (response.status === 429) {
        gwarn(`${model} quota exceeded (HTTP 429). Trying next model if available.`);
        break;
      }

      if (!response.retryable || attempt === MAX_ATTEMPTS_PER_MODEL) {
        gwarn(`${model} failed without more retries: ${response.error}`);
        break;
      }

      gwarn(`${model} attempt ${attempt} failed (${response.error}). Retrying in ${RETRY_DELAY_MS}ms...`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  const error = attempts
    .map(a => `${a.model} attempt ${a.attempt}: ${a.error || `HTTP ${a.httpStatus ?? '?'}`}`)
    .join(' | ');

  gerr(`All Gemini models failed. ${error}`);
  return {
    result: null,
    error,
    invalidKey: false,
    debugInfo: {
      model: attempts.at(-1)?.model ?? null,
      attempt: attempts.at(-1)?.attempt ?? null,
      httpStatus: attempts.at(-1)?.httpStatus ?? null,
      attempts,
    },
  };
}

export { analyzeWithGemini };
