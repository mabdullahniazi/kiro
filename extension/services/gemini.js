/**
 * TermsLens Gemini Client
 * Sends policy text to Gemini API and returns structured Analysis_Result.
 */

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_INPUT_CHARS = 100000;
const RETRY_DELAY_MS = 2000;

const ANALYSIS_PROMPT = (policyText) => `
You are a legal analyst specializing in privacy law and consumer rights. Analyze the following Terms of Service and/or Privacy Policy text and respond with ONLY a valid JSON object — no markdown, no explanation, just the raw JSON.

The JSON must conform exactly to this schema:
{
  "summary": "A 2-3 sentence plain-English summary of what this policy means for the user.",
  "dataCollected": ["list", "of", "data", "types", "collected"],
  "dataSharedWith": ["list", "of", "third", "parties", "data", "is", "shared", "with"],
  "redFlags": ["list", "of", "concerning", "practices", "in", "plain", "English"],
  "userRights": ["list", "of", "rights", "the", "user", "has"],
  "score": 7,
  "recommendation": "A single-sentence plain-English recommendation for the user."
}

Rules:
- score must be an integer between 0 and 10 (10 = excellent privacy, 0 = terrible privacy)
- All text must be in plain English — no legal jargon
- Arrays can be empty [] if nothing applies
- redFlags should highlight anything that could harm the user: excessive data collection, selling data, no deletion rights, etc.

Policy Text:
---
${policyText.slice(0, MAX_INPUT_CHARS)}
---
`.trim();

/**
 * Validate that a parsed object matches the Analysis_Result schema.
 */
function validateAnalysisResult(obj) {
  if (!obj || typeof obj !== 'object') return false;

  const checks = [
    typeof obj.summary === 'string' && obj.summary.length > 0,
    Array.isArray(obj.dataCollected),
    Array.isArray(obj.dataSharedWith),
    Array.isArray(obj.redFlags),
    Array.isArray(obj.userRights),
    typeof obj.score === 'number' && Number.isInteger(obj.score) && obj.score >= 0 && obj.score <= 10,
    typeof obj.recommendation === 'string' && obj.recommendation.length > 0,
  ];

  return checks.every(Boolean);
}

/**
 * Call the Gemini API once with a timeout.
 */
async function callGeminiOnce(apiKey, policyText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const requestBody = {
    contents: [
      {
        parts: [
          { text: ANALYSIS_PROMPT(policyText) }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
    }
  };

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.status === 401 || response.status === 403) {
      return { result: null, error: 'invalid_key', status: response.status };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { result: null, error: `Gemini API error ${response.status}: ${errText}` };
    }

    const data = await response.json();

    // Extract the text content from Gemini's response structure
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return { result: null, error: 'Empty response from Gemini API' };
    }

    // Strip markdown code fences if present
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { result: null, error: `Malformed JSON response: ${jsonText.slice(0, 100)}` };
    }

    if (!validateAnalysisResult(parsed)) {
      return { result: null, error: 'Response missing required fields or wrong types' };
    }

    return { result: parsed, error: null };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { result: null, error: 'Gemini API request timed out after 10 seconds' };
    }
    return { result: null, error: err.message };
  }
}

/**
 * Analyze policy text using Gemini. Retries once on failure.
 * Returns { result: AnalysisResult, error: string|null, invalidKey: bool }
 */
async function analyzeWithGemini(apiKey, policyText) {
  const { result, error, status } = await callGeminiOnce(apiKey, policyText);

  if (result) {
    return { result, error: null, invalidKey: false };
  }

  if (status === 401 || status === 403) {
    return { result: null, error: 'Your API key was rejected. Please update it in the options page.', invalidKey: true };
  }

  // Retry once after a delay
  await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));

  const retry = await callGeminiOnce(apiKey, policyText);

  if (retry.result) {
    return { result: retry.result, error: null, invalidKey: false };
  }

  return {
    result: null,
    error: retry.error || error || 'Analysis failed after retry',
    invalidKey: false,
  };
}

export { analyzeWithGemini };
