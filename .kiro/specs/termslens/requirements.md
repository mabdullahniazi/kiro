# Requirements Document

## Introduction

TermsLens is a Chrome browser extension that helps users understand the legal implications of Terms of Service and Privacy Policy documents on websites they visit. When a user clicks the extension icon, it automatically locates policy-related links on the current page, fetches and extracts the legal text, sends it to the Gemini AI API for analysis, and presents a plain-English summary with a privacy/risk score and highlighted red flags in the extension popup.

## Glossary

- **Extension**: The TermsLens Chrome browser extension
- **Content_Script**: The JavaScript module injected into the active tab to scan DOM and extract page data
- **Background_Script**: The Chrome extension service worker that orchestrates messaging, fetching, and API calls
- **Popup**: The HTML/CSS/JS UI rendered when the user clicks the extension icon in the Chrome toolbar
- **Policy_Detector**: The component responsible for scanning page links and identifying policy-related URLs
- **Policy_Extractor**: The component responsible for fetching policy pages and converting HTML to clean text
- **Gemini_Client**: The component responsible for sending policy text to the Gemini API and receiving structured JSON responses
- **Analyzer**: The component responsible for computing the Privacy Score and categorizing risk findings
- **Policy_Link**: An object of shape `{ type: string, url: string }` representing a discovered policy page
- **Analysis_Result**: A structured JSON object of shape `{ summary, dataCollected, dataSharedWith, redFlags, userRights, score, recommendation }` representing AI analysis output
- **Privacy_Score**: An integer between 0 and 10 representing the overall privacy risk of a site's policies
- **Red_Flag**: A specific finding within a policy that represents elevated risk to the user
- **Active_Tab**: The browser tab currently in focus when the user clicks the extension icon

---

## Requirements

### Requirement 1: Policy Link Detection

**User Story:** As a user visiting a website, I want the extension to automatically find all policy-related links on the page, so that I do not have to manually locate Terms of Service or Privacy Policy pages.

#### Acceptance Criteria

1. WHEN the user clicks the extension icon, THE Content_Script SHALL scan all anchor elements on the Active_Tab's DOM for links whose text or href contains at least one of the following keywords (case-insensitive): `privacy`, `privacy policy`, `terms`, `terms of service`, `terms and conditions`, `cookie policy`, `legal`.
2. WHEN matching links are found, THE Policy_Detector SHALL return a typed list of Policy_Link objects, each containing a `type` field (one of: `privacy-policy`, `terms-of-service`, `terms-and-conditions`, `cookie-policy`, `legal`) and a `url` field containing the fully resolved absolute URL.
3. WHEN a relative URL is found in a matching link, THE Policy_Detector SHALL resolve it to an absolute URL using the Active_Tab's origin.
4. IF no matching links are found on the Active_Tab, THEN THE Popup SHALL display a message informing the user that no policy links were detected on the current page.
5. THE Policy_Detector SHALL deduplicate Policy_Link entries so that the same URL does not appear more than once in the result list.

---

### Requirement 2: Policy Text Extraction

**User Story:** As a user, I want the extension to fetch and clean the legal text from policy pages, so that only the relevant legal content is sent for analysis rather than navigation menus, ads, and boilerplate.

#### Acceptance Criteria

1. WHEN a list of Policy_Link objects is available, THE Policy_Extractor SHALL fetch the HTML content of each linked URL via the Background_Script using the `fetch` API.
2. WHEN HTML content is fetched, THE Policy_Extractor SHALL parse the HTML and remove the following element types before extracting text: `nav`, `header`, `footer`, `aside`, `script`, `style`, `iframe`, `form`, `[role="banner"]`, `[role="navigation"]`, `[role="complementary"]`.
3. WHEN cleaned HTML is available, THE Policy_Extractor SHALL extract the remaining visible text content and normalize whitespace so the output contains no consecutive blank lines exceeding two.
4. IF a fetch request for a policy URL fails with a non-2xx HTTP status or a network error, THEN THE Policy_Extractor SHALL skip that URL and record the failure so THE Popup can surface an error message for that specific link.
5. THE Policy_Extractor SHALL truncate the combined extracted text to a maximum of 30,000 characters before passing it to the Gemini_Client, prioritizing content from the beginning of the document.

---

### Requirement 3: AI Analysis via Gemini

**User Story:** As a user, I want the extracted policy text to be analyzed by an AI model, so that I receive a structured, machine-readable breakdown of what the policies say.

#### Acceptance Criteria

1. WHEN cleaned policy text is available, THE Gemini_Client SHALL send the text to the Gemini API with a structured prompt requesting a JSON response conforming to the Analysis_Result schema.
2. THE Gemini_Client SHALL include the following fields in every Analysis_Result response: `summary` (string), `dataCollected` (array of strings), `dataSharedWith` (array of strings), `redFlags` (array of strings), `userRights` (array of strings), `score` (integer 0–10), `recommendation` (string).
3. WHEN the Gemini API returns a valid JSON response, THE Gemini_Client SHALL parse and validate that the response contains all required Analysis_Result fields before passing it to the Analyzer.
4. IF the Gemini API returns an error or a malformed response, THEN THE Background_Script SHALL retry the request once before surfacing an error message in THE Popup.
5. THE Gemini_Client SHALL not expose the Gemini API key in any content script, popup script, or any file accessible to web page JavaScript; the key SHALL be stored and used only within the Background_Script.

---

### Requirement 4: Risk Detection and Categorization

**User Story:** As a user, I want the extension to categorize identified risks by type, so that I can quickly understand what kinds of data practices are present in the policy.

#### Acceptance Criteria

1. WHEN an Analysis_Result is received, THE Analyzer SHALL classify each identified risk into one of the following categories: `Data Collection` (e.g., email, phone, location, device ID), `Data Sharing` (e.g., advertisers, analytics providers, partners), `Tracking` (e.g., cookies, fingerprinting, behavioral profiling), `Data Retention` (e.g., permanent storage, long-term retention without defined expiry).
2. WHEN risk categorization is complete, THE Analyzer SHALL produce a list of categorized Red_Flag objects, each containing a `category` field and a `description` field in plain English.
3. THE Analyzer SHALL surface at least all red flags returned in the `redFlags` array of the Analysis_Result as categorized Red_Flag objects.
4. IF the Analysis_Result contains no entries in the `redFlags` array, THEN THE Popup SHALL display a message indicating no significant red flags were identified.

---

### Requirement 5: Privacy Score Calculation

**User Story:** As a user, I want to see a numeric privacy score so that I can quickly assess how privacy-friendly a site's policies are at a glance.

#### Acceptance Criteria

1. WHEN an Analysis_Result is received, THE Analyzer SHALL compute a Privacy_Score starting at 10 and applying the following deductions: sells user data (−3), shares data with advertisers (−2), location tracking (−2), biometric data collection (−3), unlimited or undefined data retention (−2).
2. WHEN positive practices are identified in the Analysis_Result, THE Analyzer SHALL apply the following additions to the Privacy_Score: data deletion rights offered (+1), data export rights offered (+1), opt-out options available (+1).
3. THE Analyzer SHALL clamp the final Privacy_Score to the inclusive range [0, 10].
4. WHEN the Privacy_Score is computed, THE Analyzer SHALL also produce a qualitative label: scores 0–3 SHALL be labeled `High Risk`, scores 4–6 SHALL be labeled `Moderate Risk`, scores 7–9 SHALL be labeled `Low Risk`, and a score of 10 SHALL be labeled `Excellent`.
5. THE Popup SHALL display the Privacy_Score and its qualitative label prominently.

---

### Requirement 6: Plain-English Explanation Display

**User Story:** As a non-lawyer user, I want the analysis presented in plain English with clear sections, so that I can understand what a policy means without legal expertise.

#### Acceptance Criteria

1. WHEN an Analysis_Result is available, THE Popup SHALL display the following sections in order: site domain, Privacy_Score with qualitative label, summary, data collected, data shared with, red flags (categorized), user rights, and recommendation.
2. THE Popup SHALL render all Analysis_Result text fields using plain English as returned by the Gemini_Client, without displaying raw legal excerpts or JSON.
3. THE Popup SHALL visually distinguish Red_Flag items from neutral information items using color or iconography.
4. WHEN the analysis is loading, THE Popup SHALL display a loading indicator so the user is aware that processing is in progress.
5. THE Popup SHALL display the domain of the Active_Tab at the top of the results view so the user can confirm which site is being analyzed.

---

### Requirement 7: End-to-End Performance

**User Story:** As a user, I want analysis results to appear quickly, so that checking a site's policies does not disrupt my browsing workflow.

#### Acceptance Criteria

1. WHEN the user clicks the extension icon, THE Extension SHALL complete the full workflow — link detection, text extraction, AI analysis, and result display — within 15 seconds under normal network conditions.
2. WHEN a step in the workflow exceeds its individual time budget, THE Popup SHALL display a timeout error message specifying which step timed out.
3. THE Policy_Extractor SHALL complete HTML fetching and text extraction for all detected policy links within 5 seconds of initiating fetches.
4. THE Gemini_Client SHALL set a request timeout of 10 seconds on Gemini API calls; IF the timeout is exceeded, THEN THE Background_Script SHALL treat the call as a failure and surface an error in THE Popup.

---

### Requirement 8: Extension Configuration and API Key Management

**User Story:** As a user setting up the extension, I want a secure and straightforward way to provide my Gemini API key, so that the extension can perform AI analysis without exposing my credentials.

#### Acceptance Criteria

1. WHEN the extension is installed and no Gemini API key is configured, THE Popup SHALL display a setup prompt directing the user to enter their Gemini API key in the extension's options page.
2. WHEN the user saves a Gemini API key via the options page, THE Extension SHALL store the key using `chrome.storage.local` and SHALL NOT transmit the key to any endpoint other than the official Gemini API.
3. WHEN the user clicks the extension icon and a valid API key is stored, THE Extension SHALL proceed directly to policy detection without showing the setup prompt.
4. THE Extension's options page SHALL provide a way for the user to clear or update the stored API key.
