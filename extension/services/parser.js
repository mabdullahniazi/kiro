/**
 * TermsLens Parser Service
 * Fetches policy pages and extracts clean text from HTML.
 */

const ELEMENTS_TO_REMOVE = [
  'nav', 'header', 'footer', 'aside', 'script', 'style',
  'iframe', 'form', 'noscript', 'picture',
  '[role="banner"]', '[role="navigation"]', '[role="complementary"]',
  '[role="search"]', '[aria-hidden="true"]',
  '.cookie-banner', '.ad', '.advertisement', '.sidebar',
];

const MAX_COMBINED_CHARS = 30000;
const FETCH_TIMEOUT_MS = 10000;

/**
 * Fetch a URL with a timeout. Returns { html, error }.
 */
async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TermsLens/1.0)',
      },
    });

    clearTimeout(timer);

    if (!response.ok) {
      return { html: null, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const html = await response.text();
    return { html, error: null };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { html: null, error: 'Fetch timed out after 10 seconds' };
    }
    return { html: null, error: err.message };
  }
}

/**
 * Clean HTML by removing unwanted elements and extract visible text.
 */
function extractCleanText(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove unwanted elements
  for (const selector of ELEMENTS_TO_REMOVE) {
    try {
      doc.querySelectorAll(selector).forEach(el => el.remove());
    } catch {
      // Ignore invalid selectors
    }
  }

  // Get the main content area if available, otherwise use body
  const mainContent =
    doc.querySelector('main') ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector('article') ||
    doc.querySelector('.content') ||
    doc.querySelector('#content') ||
    doc.body;

  if (!mainContent) return '';

  const rawText = mainContent.innerText || mainContent.textContent || '';

  // Normalize whitespace: collapse multiple blank lines to at most one
  return rawText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')          // Collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')       // Max 1 blank line between blocks
    .trim();
}

/**
 * Fetch and extract text from a list of policy links.
 * Returns { texts: string[], failures: Array<{url, reason}> }
 */
async function extractPolicyTexts(policyLinks) {
  const AGGREGATE_TIMEOUT_MS = 5000;
  const startTime = Date.now();

  const results = [];
  const failures = [];

  for (const { url, type } of policyLinks) {
    // Check aggregate time budget
    if (Date.now() - startTime >= AGGREGATE_TIMEOUT_MS) {
      failures.push({ url, reason: 'Aggregate extraction time limit exceeded' });
      continue;
    }

    const { html, error } = await fetchWithTimeout(url);
    if (error) {
      failures.push({ url, reason: error });
      continue;
    }

    const text = extractCleanText(html);
    if (text) {
      results.push({ url, type, text });
    }
  }

  // Concatenate in order, then truncate
  let combined = results.map(r => `=== ${r.type.toUpperCase()} ===\n\n${r.text}`).join('\n\n---\n\n');

  if (combined.length > MAX_COMBINED_CHARS) {
    combined = combined.slice(0, MAX_COMBINED_CHARS);
  }

  return { combinedText: combined, failures };
}

export { extractPolicyTexts };
