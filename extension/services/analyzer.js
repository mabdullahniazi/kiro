/**
 * TermsLens Analyzer Service
 * Computes Privacy Score and categorizes Red Flags from Analysis_Result.
 */

// Scoring deductions
const DEDUCTIONS = [
  { keywords: ['sell', 'sells', 'sold', 'selling', 'sale of'],         label: 'Sells user data',              points: 3 },
  { keywords: ['advertiser', 'advertising', 'ad network', 'ad partner'], label: 'Shares data with advertisers', points: 2 },
  { keywords: ['location', 'gps', 'geolocation'],                       label: 'Location tracking',            points: 2 },
  { keywords: ['biometric', 'fingerprint', 'face recognition', 'facial'], label: 'Biometric data collection',  points: 3 },
  { keywords: ['indefinitely', 'unlimited retention', 'no deletion', 'permanent', 'no expiry'], label: 'Unlimited data retention', points: 2 },
];

// Scoring bonuses
const BONUSES = [
  { keywords: ['delete your data', 'data deletion', 'right to deletion', 'request deletion', 'erasure'], label: 'Data deletion rights', points: 1 },
  { keywords: ['export', 'download your data', 'data portability', 'access your data'],                  label: 'Data export rights',   points: 1 },
  { keywords: ['opt out', 'opt-out', 'unsubscribe', 'withdraw consent', 'opt in', 'opt-in'],             label: 'Opt-out options',      points: 1 },
];

// Risk categories for red flag classification
const RISK_CATEGORIES = [
  {
    name: 'Data Collection',
    keywords: ['collect', 'email', 'phone', 'location', 'device id', 'ip address', 'personal information', 'name', 'address', 'date of birth'],
  },
  {
    name: 'Data Sharing',
    keywords: ['share', 'third party', 'partner', 'advertiser', 'analytics', 'affiliate', 'vendor', 'disclose'],
  },
  {
    name: 'Tracking',
    keywords: ['cookie', 'track', 'fingerprint', 'behavioral', 'profiling', 'pixel', 'beacon', 'monitor'],
  },
  {
    name: 'Data Retention',
    keywords: ['retain', 'store', 'indefinitely', 'permanent', 'no expiry', 'long-term', 'archive'],
  },
];

/**
 * Determine the risk category for a red flag description.
 */
function classifyRedFlag(description) {
  const lower = description.toLowerCase();
  for (const { name, keywords } of RISK_CATEGORIES) {
    if (keywords.some(k => lower.includes(k))) {
      return name;
    }
  }
  return 'Other';
}

/**
 * Check if a list of keywords appears in the given text (combined red flags + shared with).
 */
function textContainsAny(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

/**
 * Build the full analysis context string for scoring purposes.
 */
function buildScoreContext(analysisResult) {
  return [
    ...analysisResult.redFlags,
    ...analysisResult.dataSharedWith,
    analysisResult.summary,
    analysisResult.recommendation,
  ].join(' ').toLowerCase();
}

/**
 * Compute Privacy Score and produce deduction/bonus details.
 */
function computePrivacyScore(analysisResult) {
  // Use the AI-provided score as the base, or fall back to our own calculation
  const aiScore = typeof analysisResult.score === 'number' ? analysisResult.score : null;

  const context = buildScoreContext(analysisResult);
  const userRightsText = analysisResult.userRights.join(' ').toLowerCase();

  let score = 10;
  const appliedDeductions = [];
  const appliedBonuses = [];

  // Apply deductions (at most once each)
  for (const { keywords, label, points } of DEDUCTIONS) {
    if (textContainsAny(context, keywords)) {
      score -= points;
      appliedDeductions.push({ label, points });
    }
  }

  // Apply bonuses (at most once each, check user rights primarily)
  for (const { keywords, label, points } of BONUSES) {
    const combinedText = `${userRightsText} ${context}`;
    if (textContainsAny(combinedText, keywords)) {
      score += points;
      appliedBonuses.push({ label, points });
    }
  }

  // Blend AI score with calculated score (average), then clamp
  let finalScore;
  if (aiScore !== null) {
    finalScore = Math.round((aiScore + score) / 2);
  } else {
    finalScore = score;
  }

  finalScore = Math.max(0, Math.min(10, finalScore));

  // Qualitative label
  let label;
  if (finalScore === 10) {
    label = 'Excellent';
  } else if (finalScore >= 7) {
    label = 'Low Risk';
  } else if (finalScore >= 4) {
    label = 'Moderate Risk';
  } else {
    label = 'High Risk';
  }

  return { score: finalScore, label, appliedDeductions, appliedBonuses };
}

/**
 * Categorize all red flags from the Analysis_Result.
 * @returns {Array<{category: string, description: string}>}
 */
function categorizeRedFlags(analysisResult) {
  const redFlags = analysisResult.redFlags || [];

  return redFlags.map(description => ({
    category: classifyRedFlag(description),
    // Truncate to 200 chars as per spec
    description: description.length > 200 ? description.slice(0, 197) + '...' : description,
  }));
}

/**
 * Full analysis: score + categorized red flags.
 * @param {Object} analysisResult - Raw Analysis_Result from Gemini
 * @returns {{ scoreData: Object, redFlags: Array }}
 */
function processAnalysis(analysisResult) {
  const scoreData = computePrivacyScore(analysisResult);
  const redFlags = categorizeRedFlags(analysisResult);
  return { scoreData, redFlags };
}

export { processAnalysis, computePrivacyScore, categorizeRedFlags };
