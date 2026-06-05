/**
 * TermsLens Parser Service
 * Runs inside the background service worker — NO browser DOM APIs available.
 * HTML → text extraction is done with regex, not DOMParser.
 */

const TAG   = '[TermsLens:parser]';
const plog  = (...a) => console.log(TAG, ...a);
const pwarn = (...a) => console.warn(TAG,  '⚠️', ...a);
const perr  = (...a) => console.error(TAG, '❌', ...a);

const FETCH_TIMEOUT_MS   = 15000;
const MAX_COMBINED_CHARS = 30000;

// ─── Regex-based HTML → text (no DOMParser needed) ────────────────────────────

// Block-level elements whose entire tag + content we strip
const BLOCK_STRIP_RE = new RegExp(
  '<(script|style|noscript|iframe|svg|canvas|nav|header|footer|aside|form|' +
  'picture|video|audio|template)[^>]*>[\\s\\S]*?<\\/\\1>',
  'gi'
);

// Strip all remaining HTML tags
const TAG_RE        = /<[^>]+>/g;
// Collapse &nbsp; and other common entities
const NBSP_RE       = /&nbsp;/gi;
const AMP_RE        = /&amp;/gi;
const LT_RE         = /&lt;/gi;
const GT_RE         = /&gt;/gi;
const QUOT_RE       = /&quot;|&#39;/gi;
const ENTITY_RE     = /&#\d+;/g;
// Whitespace normalisers
const MULTI_SPACE   = /[ \t]+/g;
const MULTI_NEWLINE = /\n{3,}/g;

/**
 * Extract readable text from raw HTML using regex only.
 * Safe to run inside a service worker.
 */
function extractTextFromHtml(html) {
  let text = html;

  // 1. Remove block elements (script, style, nav, header, footer, etc.)
  text = text.replace(BLOCK_STRIP_RE, ' ');

  // 2. Strip all remaining tags
  text = text.replace(TAG_RE, ' ');

  // 3. Decode common HTML entities
  text = text
    .replace(NBSP_RE,   ' ')
    .replace(AMP_RE,    '&')
    .replace(LT_RE,     '<')
    .replace(GT_RE,     '>')
    .replace(QUOT_RE,   '"')
    .replace(ENTITY_RE, ' ');

  // 4. Normalise whitespace
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(MULTI_SPACE, ' ')
    .replace(MULTI_NEWLINE, '\n\n')
    .trim();

  return text;
}

// ─── Fetch with timeout ───────────────────────────────────────────────────────

async function fetchWithTimeout(url) {
  plog(`Fetching ${url}`);
  const ctrl  = new AbortController();
  const timer = setTimeout(() => {
    pwarn(`Timeout after ${FETCH_TIMEOUT_MS / 1000}s for ${url}`);
    ctrl.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'Accept':          'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control':   'no-cache',
      },
    });
    clearTimeout(timer);
    plog(`HTTP ${res.status} ${res.statusText} — ${url}`);

    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText}`;
      perr(`Fetch failed: ${msg} — ${url}`);
      return { html: null, error: msg, status: res.status };
    }

    const html = await res.text();
    plog(`Received ${html.length} bytes from ${url}`);
    return { html, error: null, status: res.status };

  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      const msg = `Timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
      perr(`${url}: ${msg}`);
      return { html: null, error: msg, status: null };
    }
    perr(`Network error for ${url}:`, e.message);
    return { html: null, error: e.message, status: null };
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Fetch and extract text from policy links in parallel.
 * @param {Array<{type: string, url: string}>} policyLinks
 * @param {Function|null} pushLog  optional (step, status, msg, detail) => void
 * @returns {{ combinedText: string, perDoc: Array, failures: Array }}
 */
async function extractPolicyTexts(policyLinks, pushLog = null) {
  const log = (step, status, msg, detail) => {
    plog(msg, detail ?? '');
    if (pushLog) pushLog(step, status, msg, detail);
  };

  log('extraction', 'info',
    `Fetching ${policyLinks.length} policy URL(s) in parallel`,
    policyLinks.map(l => `[${l.type}] ${l.url}`)
  );

  const perDoc   = [];
  const failures = [];

  const settled = await Promise.allSettled(
    policyLinks.map(async ({ type, url }) => {
      const { html, error, status } = await fetchWithTimeout(url);

      if (error || !html) {
        const reason = error || 'Empty response';
        log('extraction', 'warn', `Fetch failed [${type}] ${url}: ${reason}`, { status });
        failures.push({ type, url, reason });
        return;
      }

      const text = extractTextFromHtml(html);

      if (!text || text.length < 100) {
        const reason = `Extracted text too short (${text.length} chars)`;
        log('extraction', 'warn', `Thin result [${type}] ${url}: ${reason}`);
        failures.push({ type, url, reason });
        return;
      }

      log('extraction', 'ok', `[${type}] ${url} — ${text.length} chars`);
      perDoc.push({ type, url, text, charCount: text.length });
    })
  );

  // Surface any unexpected rejections
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      const { type, url } = policyLinks[i];
      perr(`Promise rejected [${type}] ${url}:`, s.reason);
      failures.push({ type, url, reason: String(s.reason) });
    }
  });

  if (perDoc.length === 0) {
    log('extraction', 'error', 'All policy fetches failed — no text available');
    return { combinedText: '', perDoc, failures };
  }

  const sections = perDoc.map(d => {
    const label = d.type.toUpperCase().replace(/-/g, ' ');
    return `=== ${label} ===\nSource: ${d.url}\n\n${d.text}`;
  });

  let combinedText = sections.join('\n\n' + '─'.repeat(60) + '\n\n');

  if (combinedText.length > MAX_COMBINED_CHARS) {
    pwarn(`Truncating combined text ${combinedText.length} → ${MAX_COMBINED_CHARS} chars`);
    combinedText = combinedText.slice(0, MAX_COMBINED_CHARS);
  }

  log('extraction', 'ok',
    `Combined: ${combinedText.length} chars from ${perDoc.length} doc(s)`,
    perDoc.map(d => ({ type: d.type, chars: d.charCount }))
  );

  return { combinedText, perDoc, failures };
}

export { extractPolicyTexts };
