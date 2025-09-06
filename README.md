# Auto-Apply Bot (SpeedyApply Orchestrator)

This project opens curated internship/new-grad application links each day at **12:00 PM Eastern**, lets the **SpeedyApply** extension autofill/submit where supported, and also **fills short custom questions** like “What excites you about joining X?” using your profile and a grounded template.

## What you need
1. **Chrome** (or Edge) with **SpeedyApply** extension installed and configured (profile, resume, saved answers).
2. Launch Chrome with remote debugging so this bot can open tabs in your real profile:
   - macOS:
     ```bash
     /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
     ```
   - Windows:
     ```powershell
     "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
     ```
3. Put your downloaded profile JSON in the project root as `profile.json` (or set `PROFILE_JSON` in `.env`).

## Install & run
```bash
npm i
cp .env.example .env
# edit .env if needed (e.g., MAX_PER_RUN, OPENAI_API_KEY)
npm run run-now      # test once
npm run schedule     # keep running; triggers at 12:00 PM ET daily
```

## What it does
- Pulls curated **Apply** links from the public repo **speedyapply/2026-SWE-College-Jobs**.
- De-duplicates any links already attempted (stored in `applied.json`).
- Filters by simple relevance (title/URL snippet vs skills/keywords from your profile).
- Opens each link in your Chrome session; SpeedyApply handles autofill/submit on supported ATS pages.
- Looks for short-answer fields like “What excites you about joining {Company}?”, drafts an **accurate, personal answer**, and inserts it. (If unsure, it leaves a TODO for you to review.)
- Skips gracefully if pages show CAPTCHAs or unsupported flows.

## Notes
- This bot avoids CAPTCHA bypass and ToS violations. If a portal blocks automation, it logs and stops for that URL.
- You can optionally set `OPENAI_API_KEY` to improve answer polishing; we still keep a **“no new facts”** rule.
