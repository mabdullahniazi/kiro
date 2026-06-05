# TermsLens 🔍

A Chrome extension that analyzes Terms of Service and Privacy Policies using Gemini AI — giving you a plain-English summary, privacy score, and red flag warnings in seconds.

## Features

- **Auto-detects** Privacy Policy, Terms of Service, Terms & Conditions, and Cookie Policy links on any page
- **Extracts clean text** — strips navigation, headers, footers, ads, and boilerplate
- **Gemini AI analysis** — structured breakdown of what you're agreeing to
- **Privacy Score** (0–10) with qualitative label (High Risk → Excellent)
- **Categorized red flags** — Data Collection, Data Sharing, Tracking, Data Retention
- **Plain-English explanations** — no legal jargon

## Setup

### 1. Get a free Gemini API Key
1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Sign in with your Google account
3. Click **Get API Key** → **Create API Key**
4. Copy the key

### 2. Load the extension in Chrome
1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer Mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this project

### 3. Enter your API key
1. Click the TermsLens icon in your toolbar
2. Paste your Gemini API key and click **Save Key**
   (or go to ⚙️ Settings)

### 4. Analyze any site
1. Visit any website (e.g. twitter.com, amazon.com, any SaaS product)
2. Click the TermsLens icon
3. Click **Analyze This Page**
4. Wait 5–15 seconds for results

## Project Structure

```
extension/
├── manifest.json          # Chrome extension manifest (v3)
├── popup/
│   ├── popup.html         # Popup UI
│   ├── popup.css          # Dark theme styles
│   └── popup.js           # Popup logic & state management
├── content/
│   └── content.js         # Scans page DOM for policy links
├── background/
│   └── background.js      # Service worker: orchestrates pipeline, holds API key
├── services/
│   ├── parser.js          # Fetches pages + extracts clean text
│   ├── gemini.js          # Gemini API client with retry logic
│   └── analyzer.js        # Computes privacy score + categorizes red flags
├── options/
│   ├── options.html       # Settings page
│   ├── options.css        # Settings styles
│   └── options.js         # Save/clear API key
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Privacy & Security

- Your Gemini API key is stored **only** in `chrome.storage.local` on your device
- The key is **never** sent anywhere except the official Gemini API endpoint
- No data is collected or transmitted to any third-party server
- Policy text is sent to Gemini API only when you explicitly click "Analyze"

## Privacy Score System

| Score | Label |
|-------|-------|
| 10 | ✅ Excellent |
| 7–9 | 🔵 Low Risk |
| 4–6 | 🟠 Moderate Risk |
| 0–3 | 🔴 High Risk |

**Deductions:** Sells data (−3), shares with advertisers (−2), location tracking (−2), biometric data (−3), unlimited retention (−2)

**Bonuses:** Data deletion rights (+1), data export rights (+1), opt-out options (+1)
