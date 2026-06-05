/**
 * TermsLens Parser Service
 * Fetches each policy URL in parallel and extracts clean text.
 * Accepts an optional `pushLog` callback so the background script
 * can include parser-level events in the unified debug log.
 */

// ─── Logger ───────────────────────────────────────────────────────────────────
const TAG  = '[TermsLens:parser]';
const plog  = (...a) => console.log(TAG, ...a);
const pwarn = (...a) => console.warn(TAG, '⚠️', ...a);
const perr  = (...a) => console.error(TAG, '❌', ...a);

// ─── Config ───────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS   = 15000;
const MAX_COMBINED_CHARS = 30000;

const STRIP_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
  'nav', 'header', 'footer', 'aside',
  'form', 'picture', 'video', 'audio',
];

const BOILERPLATE_WORDS = [
  'cookie-notice', 'cookie-banner', 'cookie-bar',
  'advertisement', 'popup', 'modal', 'sidebar', 'side-bar',
];

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function fetchWithTimeout(url) {
  plog(`Fetching ${url}`);
  const ctrl  = new AbortController();
  const timer = setTimeout(() => { pwarn(`Timeout for ${url}`); ctrl.abort(); }, FETCH_TIMEOUT_MS);

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
    plog(`HTTP ${res.status} ${res.statusText} for ${url}`);

    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText}`;
      perr(`Fetch failed for ${url}: ${msg}`);
      return { html: null, error: msg, status: res.status };
    }
    const html = await res.text();
    plog(`Fetched ${html.length} bytes from ${url}`);
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

// ─── HTML → text ──────────────────────────────────────────────────────────────
function stripTagBlocks(html, tagName) {
  const block = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}\\s*>`, 'gi');
  return html.replace(block, ' ');
}

function stripBoilerplateElements(html) {
  let output = html;

  for (const word of BOILERPLATE_WORDS) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const attrMatcher = `(?:class|id)=["'][^"']*${escaped}[^"']*["']`;
    const paired = new RegExp(`<([a-z][\\w:-]*)\\b(?=[^>]*${attrMatcher})[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
    const single = new RegExp(`<[a-z][\\w:-]*\\b(?=[^>]*${attrMatcher})[^>]*\\/?>`, 'gi');
    output = output.replace(paired, ' ').replace(single, ' ');
  }

  output = output
    .replace(/<([a-z][\w:-]*)\b(?=[^>]*aria-hidden=["']true["'])[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<([a-z][\w:-]*)\b(?=[^>]*role=["'](?:banner|navigation|complementary|search)["'])[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

  return output;
}

function decodeHtmlEntities(text) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (_entity, value) => {
    const lower = value.toLowerCase();
    if (lower[0] === '#') {
      const codePoint = lower[1] === 'x'
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      if (Number.isFinite(codePoint)) {
        try { return String.fromCodePoint(codePoint); }
        catch { return ' '; }
      }
      return ' ';
    }
    return named[lower] ?? ' ';
  });
}

function pickBodyHtml(html) {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

function extractCleanText(html, sourceUrl) {
  plog(`Parsing HTML (${html.length} bytes) for ${sourceUrl}`);

  let working = pickBodyHtml(html);
  for (const tagName of STRIP_TAGS) {
    working = stripTagBlocks(working, tagName);
  }
  working = stripBoilerplateElements(working);

  const raw = working
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/section|\/article|\/main|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const clean = decodeHtmlEntities(raw)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  plog(`Extracted ${clean.length} chars from ${sourceUrl}`);
  return clean;
}

// ─── Main export ──────────────────────────────────────────────────────────────
/**
 * Fetch and extract policy text from a list of links.
 * @param {Array<{type,url}>}  policyLinks
 * @param {Function|null}      pushLog  — optional (step,status,msg,detail)=>void
 * @returns {{ combinedText, perDoc, failures }}
 */
async function extractPolicyTexts(policyLinks, pushLog = null) {
  const log = (step, status, msg, detail) => {
    plog(msg, detail ?? '');
    if (pushLog) pushLog(step, status, msg, detail);
  };

  log('extraction', 'info', `Fetching ${policyLinks.length} policy URL(s) in parallel`,
    policyLinks.map(l => `[${l.type}] ${l.url}`));

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

      const text = extractCleanText(html, url);
      if (!text || text.length < 50) {
        const reason = `Extracted text too short (${text.length} chars)`;
        log('extraction', 'warn', `Extraction thin [${type}] ${url}: ${reason}`);
        failures.push({ type, url, reason });
        return;
      }

      log('extraction', 'ok', `[${type}] ${url} — ${text.length} chars extracted`);
      perDoc.push({ type, url, text, charCount: text.length });
    })
  );

  // Surface any Promise rejections (shouldn't happen but log them)
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      const { type, url } = policyLinks[i];
      perr(`Promise rejected for [${type}] ${url}:`, s.reason);
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
    pwarn(`Truncating combined text from ${combinedText.length} to ${MAX_COMBINED_CHARS} chars`);
    combinedText = combinedText.slice(0, MAX_COMBINED_CHARS);
  }

  log('extraction', 'ok',
    `Combined text: ${combinedText.length} chars from ${perDoc.length} document(s)`,
    perDoc.map(d => ({ type: d.type, chars: d.charCount })));

  return { combinedText, perDoc, failures };
}

export { extractPolicyTexts };
