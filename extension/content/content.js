/**
 * TermsLens Content Script
 * Injected into all pages. Scans for policy links on demand.
 */

const POLICY_KEYWORDS = [
  { pattern: /privacy\s+policy/i,       type: 'privacy-policy' },
  { pattern: /terms\s+of\s+service/i,   type: 'terms-of-service' },
  { pattern: /terms\s+and\s+conditions/i, type: 'terms-and-conditions' },
  { pattern: /cookie\s+policy/i,        type: 'cookie-policy' },
  { pattern: /privacy/i,                type: 'privacy-policy' },
  { pattern: /terms/i,                  type: 'terms-of-service' },
  { pattern: /legal/i,                  type: 'legal' },
];

/**
 * Determine the policy type for a given text/href string.
 * Returns the type string or null if no match.
 */
function detectPolicyType(text, href) {
  const combined = `${text} ${href}`.toLowerCase();
  for (const { pattern, type } of POLICY_KEYWORDS) {
    if (pattern.test(combined)) {
      return type;
    }
  }
  return null;
}

/**
 * Resolve a potentially relative URL to absolute using the current page origin.
 */
function resolveUrl(href) {
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return null;
  }
}

/**
 * Scan all anchor elements on the page and return policy links.
 * @returns {Array<{type: string, url: string}>}
 */
function detectPolicyLinks() {
  const anchors = document.querySelectorAll('a[href]');
  const seen = new Set();
  const links = [];

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    const text = anchor.textContent || '';

    // Skip empty, javascript:, mailto:, tel: links
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      continue;
    }

    const type = detectPolicyType(text, href);
    if (!type) continue;

    const absoluteUrl = resolveUrl(href);
    if (!absoluteUrl) continue;

    // Deduplicate by URL
    if (seen.has(absoluteUrl)) continue;
    seen.add(absoluteUrl);

    links.push({ type, url: absoluteUrl });
  }

  return links;
}

// Listen for messages from the background script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'DETECT_POLICY_LINKS') {
    try {
      const links = detectPolicyLinks();
      sendResponse({ success: true, links });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true; // Keep message channel open
  }
});
