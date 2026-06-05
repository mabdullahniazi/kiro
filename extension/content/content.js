/**
 * TermsLens Content Script
 * Injected into every page at document_idle.
 *
 * Two modes:
 *  A) Current page IS a policy page → extract text from this page directly.
 *  B) Current page has LINKS to policy pages → return those links for the
 *     background script to fetch separately.
 *
 * Both modes can be true at the same time (e.g. a site whose /privacy page
 * also links to /terms in its footer).
 */

// ─── Logger (visible in the page's DevTools console) ─────────────────────────
const TAG = '[TermsLens:content]';
const clog  = (...a) => console.log(TAG, ...a);
const cwarn = (...a) => console.warn(TAG, '⚠️', ...a);
const cerr  = (...a) => console.error(TAG, '❌', ...a);

// ─── Policy URL patterns — used to detect if THIS page is a policy page ──────
const POLICY_PAGE_PATTERNS = [
  { re: /\/(privacy[-_]?policy|privacy)\b/i,          type: 'privacy-policy' },
  { re: /\/(terms[-_]?of[-_]?service|tos)\b/i,        type: 'terms-of-service' },
  { re: /\/(terms[-_]?and[-_]?conditions|terms)\b/i,  type: 'terms-of-service' },
  { re: /\/(cookie[-_]?policy|cookies)\b/i,           type: 'cookie-policy' },
  { re: /\/legal\b/i,                                 type: 'legal' },
  { re: /\/(user[-_]?agreement|eula)\b/i,             type: 'terms-of-service' },
  { re: /\/(data[-_]?policy)\b/i,                     type: 'privacy-policy' },
];

// ─── Link keyword patterns — used to find links TO policy pages ───────────────
const LINK_KEYWORDS = [
  { re: /privacy\s+policy/i,          type: 'privacy-policy' },
  { re: /terms\s+of\s+service/i,      type: 'terms-of-service' },
  { re: /terms\s+and\s+conditions/i,  type: 'terms-and-conditions' },
  { re: /cookie\s+policy/i,           type: 'cookie-policy' },
  { re: /data\s+policy/i,             type: 'privacy-policy' },
  { re: /user\s+agreement/i,          type: 'terms-of-service' },
  { re: /\bprivacy\b/i,               type: 'privacy-policy' },
  { re: /\bterms\b/i,                 type: 'terms-of-service' },
  { re: /\blegal\b/i,                 type: 'legal' },
];

// ─── Boilerplate selectors to remove before text extraction ──────────────────
const STRIP_SELECTORS = [
  'script','style','noscript','iframe','svg','canvas',
  'nav','header','footer','aside',
  'form','picture','video','audio',
  '[role="banner"]','[role="navigation"]','[role="complementary"]','[role="search"]',
  '[aria-hidden="true"]',
  '.cookie-notice','.cookie-banner','.cookie-bar',
  '.ad','.ads','.advertisement',
  '.sidebar','.side-bar',
  '.popup','.modal',
  '#cookie-notice','#cookie-banner',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Check if the current URL matches a known policy page pattern. */
function detectCurrentPageType(url) {
  const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  for (const { re, type } of POLICY_PAGE_PATTERNS) {
    if (re.test(path)) {
      clog(`Current page is a policy page: [${type}] path="${path}"`);
      return type;
    }
  }
  return null;
}

/** Extract clean text from a DOM node (removes boilerplate children first). */
function extractTextFromNode(rootNode) {
  // Clone so we don't mutate the live DOM
  const clone = rootNode.cloneNode(true);
  let removed = 0;
  for (const sel of STRIP_SELECTORS) {
    try {
      clone.querySelectorAll(sel).forEach(el => { el.remove(); removed++; });
    } catch { /* ignore bad selectors */ }
  }
  clog(`Stripped ${removed} boilerplate elements`);

  const raw = clone.textContent || clone.innerText || '';
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Find the best content container on the page. */
function findMainContent() {
  const candidates = [
    'main',
    '[role="main"]',
    'article',
    '.policy-content',
    '.legal-content',
    '.content-body',
    '.terms-content',
    '.privacy-content',
    '#main-content',
    '#content',
    '.content',
    '.container',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim().length > 200) {
      clog(`Using content container: ${sel}`);
      return el;
    }
  }
  clog('No specific content container found — using document.body');
  return document.body;
}

/** Resolve a raw href to an absolute URL. */
function resolveUrl(href) {
  try { return new URL(href, window.location.href).href; }
  catch { return null; }
}

/** Detect the policy type for a given anchor's text + href. */
function getLinkType(text, href) {
  const combined = `${(text||'').trim()} ${href||''}`;
  for (const { re, type } of LINK_KEYWORDS) {
    if (re.test(combined)) return type;
  }
  return null;
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * If this page is itself a policy page, extract its text and return it
 * as a "self" document so the background script can skip fetching it.
 * Returns null if this is not a policy page.
 */
function extractSelfIfPolicyPage() {
  const url  = window.location.href;
  const type = detectCurrentPageType(url);
  if (!type) return null;

  clog(`Extracting text from current policy page [${type}]: ${url}`);
  const container = findMainContent();
  const text = extractTextFromNode(container);

  if (!text || text.length < 100) {
    cwarn(`Extracted text too short (${text.length} chars) — page may not be loaded yet`);
    return null;
  }

  clog(`Self-extraction complete: ${text.length} chars`);
  return { type, url, text, source: 'self' };
}

/**
 * Scan all anchor tags and return unique policy links found on this page.
 * Already-visited policy page (self) is excluded to avoid duplicate fetching.
 */
function findLinkedPolicies() {
  const selfUrl  = window.location.href;
  const anchors  = document.querySelectorAll('a[href]');
  clog(`Scanning ${anchors.length} anchor elements for policy links`);

  const seen  = new Set([selfUrl]); // exclude self
  const links = [];

  for (const a of anchors) {
    const rawHref = (a.getAttribute('href') || '').trim();
    const text    = (a.textContent || a.innerText || '').trim().replace(/\s+/g, ' ');

    if (!rawHref
      || rawHref.startsWith('javascript:')
      || rawHref.startsWith('mailto:')
      || rawHref.startsWith('tel:')
      || rawHref.startsWith('#')) continue;

    const type = getLinkType(text, rawHref);
    if (!type) continue;

    const abs = resolveUrl(rawHref);
    if (!abs) { cwarn(`Could not resolve URL: ${rawHref}`); continue; }

    if (seen.has(abs)) { clog(`Duplicate skipped: ${abs}`); continue; }
    seen.add(abs);

    clog(`Found link [${type}] "${text.slice(0,40)}" → ${abs}`);
    links.push({ type, url: abs, linkText: text.slice(0, 80) });
  }

  clog(`Link scan done: ${links.length} unique policy links found`);
  return links;
}

// ─── State + initial scan ─────────────────────────────────────────────────────
let state = {
  selfDoc:   null,   // extracted text from this page if it IS a policy page
  links:     [],     // links to other policy pages found on this page
  scanDone:  false,
};

function runFullScan() {
  clog('--- Running full page scan ---');
  clog(`URL: ${window.location.href}`);
  clog(`readyState: ${document.readyState}`);
  clog(`Total anchors: ${document.querySelectorAll('a').length}`);

  state.selfDoc  = extractSelfIfPolicyPage();
  state.links    = findLinkedPolicies();
  state.scanDone = true;

  clog(`Scan complete — selfDoc: ${state.selfDoc ? `[${state.selfDoc.type}] ${state.selfDoc.text.length} chars` : 'null'}, links: ${state.links.length}`);
}

// Run immediately
runFullScan();

// Re-run once after delay to pick up dynamically rendered footer content
setTimeout(() => {
  clog('Re-scan after 1500ms (dynamic content)');
  runFullScan();
}, 1500);

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  clog(`Message received: "${msg.action}"`);

  if (msg.action === 'DETECT_POLICY_LINKS') {
    if (!state.scanDone) {
      clog('Scan not yet complete — running now');
      runFullScan();
    }

    const reply = {
      success: true,
      // Links to external policy pages to fetch
      links:   state.links,
      // If this page itself is a policy page, include its extracted text directly
      // so the background script does NOT need to fetch it again
      selfDoc: state.selfDoc
        ? { type: state.selfDoc.type, url: state.selfDoc.url, text: state.selfDoc.text }
        : null,
      pageUrl: window.location.href,
      debug: {
        totalAnchors:   document.querySelectorAll('a').length,
        selfDetected:   !!state.selfDoc,
        selfType:       state.selfDoc?.type ?? null,
        selfCharCount:  state.selfDoc?.text?.length ?? 0,
        linksFound:     state.links.length,
      },
    };

    clog('Sending reply:', JSON.stringify(reply.debug));
    sendResponse(reply);
    return true;
  }

  if (msg.action === 'PING') {
    sendResponse({ alive: true, url: window.location.href });
    return true;
  }
});

clog('Content script ready on', window.location.href);
