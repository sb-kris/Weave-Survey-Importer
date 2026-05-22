# Weave — SurveySparrow Survey Importer

Paste structured text, get a SurveySparrow draft survey. Weave turns a plain-text spec into a fully-built survey — sections, every supported question type, welcome and thank-you screens, optional display logic — without leaving your browser.

Built as a single-process **Node.js + Express** app serving a vanilla HTML/CSS/JS frontend. No bundler, no React, no build step.

---

## Features

- **Bring any source** — PDF, Word, CSV, XLSX, rough notes, broad survey brief. Open the built-in Formatting Helper, paste the cleanup prompt into ChatGPT or Claude, drop the file in, get back the exact structure Weave understands.
- **Per-surveyType ChatGPT/Claude prompt** — the cleanup prompt re-builds itself based on whether you're creating a ClassicForm, NPS, CES, or CSAT survey, so the LLM only ever emits valid structures for the survey type you picked.
- **Validate before you create** — confidence column, parser warnings, type inference notes. Hide-when-empty columns keep the table compact for simple surveys.
- **Position-strict NPS / CES / CSAT feedback** — the score question + its open-text follow-up are silently merged into a single `NPSFeedback` / `CESFeedback` / `CSATFeedback` block with per-rating bucket text. Stray reason-prompts later in the survey stay as Long text (SurveySparrow only allows one feedback question per survey).
- **Folder placement** — pick the destination folder from a live dropdown that auto-populates on connect. Folder ID is verified directly from the create-survey response, no extra round-trip.
- **Session-wide variables** — define SurveySparrow context fields (`customer_email`, `lifecycle_stage`, etc.) once in the **Variables** card and Weave attaches them automatically to every survey it creates. Types: String / Number / Date. Persisted to `localStorage`, applied via `POST /v3/variables/batch` after each successful create.
- **Survey behavior toggles** — opt-in checkboxes for **Track IP address**, **Track location**, and **Allow partial submission**. Each maps directly to the corresponding `settings.*` field on `POST /v3/surveys` and is only sent when checked, so SurveySparrow's defaults apply otherwise.
- **Built-in theme system** — light/dark + four colour themes (default indigo, cobalt, graphite, crimson), persisted to `localStorage`. Smooth view-transitions when supported.
- **Audio + animation feedback** — success chime, error chime, celebration with confetti on the first successful import per session. Reveal-on-scroll for the cards. All optional, toggleable from the Theme menu.

---

## Run locally

Requirements: Node.js v20+.

```bash
npm install
npm run dev
```

The dev server listens on `http://localhost:3001` and watches `src/` for changes (via `tsx watch`). The same port serves the HTML UI and the `/api/*` routes — no proxy needed.

For a production-style start (no watch):

```bash
npm start
```

Typecheck-only:

```bash
npm run typecheck
```

---

## Deploy to Render

This repo ships with a [`render.yaml`](render.yaml) blueprint.

1. Fork the repo.
2. Sign in to [render.com](https://dashboard.render.com) → **New +** → **Blueprint**.
3. Connect your fork. Render reads `render.yaml`, provisions a free web service, runs `npm install`, then `npm start`.
4. The service exposes the UI at the assigned `*.onrender.com` URL and the API at `/api/*`.

Render injects `PORT` automatically; no extra environment variables are required. `NODE_ENV=production` and `LOG_LEVEL=info` are set by the blueprint, and the health check endpoint at `/api/healthz` keeps the instance hot.

> **Security note.** A user's SurveySparrow API key is sent in each request body and cached in their own browser's `localStorage` — it's never stored server-side. If you're deploying publicly, put the service behind your own auth layer (SSO, basic auth, Cloudflare Access, etc.) so only your team can reach it.

---

## How it works

```
┌────────────────────────────┐
│  index.html  (vanilla JS)  │
│  ─ Parses prompt, shows    │
│    preview + confidence    │
│  ─ Calls /api endpoints    │
└────────────┬───────────────┘
             │ POST /api/folders
             │ POST /api/create-survey
             ▼
┌────────────────────────────┐
│  src/routes/surveysparrow  │
│  ─ parsePrompt()           │
│  ─ inferType()             │
│  ─ mergeFeedbackFollowups()│
│  ─ buildEnrichedBody()     │
│  ─ attemptCreateQuestion() │
└────────────┬───────────────┘
             │ Bearer token
             ▼
       SurveySparrow REST API
       (region-aware base URL)
```

### Layout

```
.
├─ index.html             ← UI (vanilla HTML/CSS/JS, ~3.3K lines)
├─ render.yaml            ← Render Blueprint (one-click deploy)
├─ public/                ← static assets served by Express
│   ├─ favicon-32x32.png
│   ├─ weave-logo.svg
│   ├─ surveysparrow-symbol.svg
│   └─ sounds/            ← UI feedback sounds (button, success, error, celebration)
├─ src/
│   ├─ index.ts           ← Entry point. Reads PORT, starts the server.
│   ├─ app.ts             ← Express setup. Serves index.html at /, /api/*, public/*
│   ├─ lib/logger.ts      ← Pino logger
│   └─ routes/
│       └─ surveysparrow.ts ← All survey logic — parser, type inference,
│                              feedback merging, payload builders, fallback
│                              chains, folder verification.
├─ package.json
├─ tsconfig.json
└─ .env.example
```

### Endpoints

| Method | Path                    | Purpose                                                                |
|--------|-------------------------|------------------------------------------------------------------------|
| POST   | `/api/folders`          | List the user's survey folders for the given region + API key.         |
| POST   | `/api/create-survey`    | Parse a prompt and create the survey + sections + questions.           |
| POST   | `/api/variables-batch`  | Attach session-wide context variables to an already-created survey. Body: `{ region, apiKey, surveyId, variables: [{ name, label?, type, description? }] }`. Types: `STRING` / `NUMBER` / `DATE`. Max 50 per call. |
| POST   | `/api/format-with-llm`  | Optional BYO-key formatter. Body: `{ provider, apiKey, surveyType, rawText, options }`. Provider is `openai` / `anthropic` / `gemini`. Sends `rawText` to the user-supplied LLM with a structured-prompt instruction; returns `{ formattedPrompt, warnings }`. The LLM key is never stored or logged server-side and is redacted from any error string before it leaves the process. 30 KB input cap. |
| GET    | `/api/healthz`          | Liveness probe (used by Render's health check).                        |

The API key is sent in every request body and is never persisted server-side.

### Key functions in `src/routes/surveysparrow.ts`

- **`parsePrompt(rawPrompt)`** — Regex-driven parser that turns the structured text into a `ParsedPrompt` (title, surveyType, welcome/thank-you, sections, questions, options/rows/columns, scales, show-if, feedback-bucket fields).
- **`inferType(q)`** — Maps the `Type:` field (with synonym table) and falls back to text-pattern heuristics. Recognises `NPS`/`CES`/`CSAT` plus the explicit `NPSFeedback`/`CESFeedback`/`CSATFeedback` aliases.
- **`mergeFeedbackFollowups(questions, surveyType)`** — Position-strict pass. For NPS/CES/CSAT surveys:
  - Score Q + explicit feedback Q right after → drop score, keep feedback Q.
  - Score Q + plain open-text right after → drop score, coerce open-text to feedback type.
  - Score Q alone → drop (rating step is implicit).
  - Orphan feedback Q (not directly after a score) → downgrade to Long text.
- **`getCompatibleQuestionType(...)`** — In ClassicForm surveys, NPSFeedback/CESFeedback/CSATFeedback get remapped to OpinionScale/Rating (with a note in the result UI).
- **`buildEnrichedBody(q, type)`** — Type-specific payload shapes (Rating scale, Opinion scale min/max, Yes/No icons, DateTime variants, Signature flags, File upload limits, Feedback buckets).
- **`attemptCreateQuestion(...)`** — Enriched-first strategy. If SurveySparrow 400s, retries with the minimal payload, then falls back to a compatible type (e.g. RankOrder → MultiChoice, FileInput → TextInput).
- **`attemptMatrix` / `attemptConstantSum` / `attemptConsent` / `attemptDateTime`** — Dedicated handlers for the types that need bespoke shapes.
- **`mapDisplayLogicComparator(...)`** — Translates `Show if: Q3 equals Yes` into SurveySparrow's typed comparator + value format.

Region endpoints are listed at the top of the file in `REGION_URLS` — US, EU, AP, ME, UK, CA, SYDNEY.

---

## The prompt format

Documented inside the app — click **Open Formatting Helper** for the canonical reference and the copyable ChatGPT/Claude prompt. The supported shape:

```
Survey Title: …
Survey Type: ClassicForm | NPS | CES | CSAT
Welcome Title: …
Welcome Description: …
Thank You Message: …
Thank You Description: …

Section: Section name        (optional — only when the source clearly groups questions)

Q1. Question text
Type: Short text | Long text | Email | Phone | Number | URL | Date |
      Single choice | Multiple choice | Dropdown | Yes/No |
      Rating | Opinion scale | NPS | CSAT | CES |
      NPSFeedback | CESFeedback | CSATFeedback |
      Matrix | Bipolar matrix | Rank order | Constant sum | Slider |
      File upload | Image upload | Audio upload | Signature | Consent | Message
Description: …
Options:
  - …
Rows:
  - …
Columns:
  - …
Scale: 1-5 | 1-10
Min label: …
Max label: …
Other: Yes
None of the above: Yes
All of the above: Yes
Randomize options: Yes
Consent text: …
Promoter: …            (NPSFeedback only)
Passive: …             (NPSFeedback only)
Detractor: …           (NPSFeedback only)
Low effort: …          (CESFeedback only)
Neutral: …             (CESFeedback only)
High effort: …         (CESFeedback only)
Satisfied: …           (CSATFeedback only)
Dissatisfied: …        (CSATFeedback only)
Required: Yes | No
Show if: Q1 equals Yes | Q3 is less than 5 | Q2 contains "support"
```

The Formatting Helper modal contains the full prompt you can drop into ChatGPT or Claude to convert any source material (PDF, Word, CSV, XLSX, raw notes, brief) into this format.

---

## Variables

SurveySparrow references survey-context variables (the customer's name, a ticket ID, etc.) with **dollar-prefix syntax**:

```
$customer_name
$account_name
$ticket_id
$customer_email
```

You can use these anywhere inside your structured prompt — Survey Title, Welcome Title / Description, Question text, Question descriptions, Options, Thank You Message / Description.

The **Variables** card lets you register variables that will be attached to every survey you create in the session (single Add or Bulk paste). Each saved variable shows up as `$name` and the Copy button copies `$name` to your clipboard, ready to paste into the structured prompt.

**Legacy `{{name}}` is accepted on input.** If you paste a prompt from older docs or an LLM that uses double-curly placeholders like `{{customer_name}}`, Weave converts them to `$customer_name` automatically just before sending the payload to SurveySparrow. The Validate Format preview shows a small blue note when curly-brace variables are detected so you know the conversion will happen, and the Create Survey result lists how many were converted.

Rules for the conversion:

| Input                          | Stored / sent as     |
|--------------------------------|----------------------|
| `{{customer_name}}`            | `$customer_name`     |
| `{{ customer_name }}`          | `$customer_name`     |
| `{{ customer name }}`          | `$customer_name`     |
| `{{Customer-Email}}`           | `$customer_email`    |
| `{{ ticket_id }}`              | `$ticket_id`         |

Spaces and hyphens become underscores; the key is lowercased; invalid characters are dropped. Anything that doesn't look like a simple placeholder (e.g. JSON-style `{{ ... }}` containing punctuation) is left untouched.

---

## Local storage keys

| Key                                | Purpose                                                  |
|------------------------------------|----------------------------------------------------------|
| `ss_region` / `ss_api_key`         | Optional credential cache (set by **Connect**).          |
| `plumage_color_theme`              | Selected colour theme (`default` / `cobalt` / `graphite` / `crimson`). |
| `plumage_color_mode`               | `light` / `dark`.                                        |
| `plumage_sound_enabled`            | Status sounds toggle.                                    |
| `plumage_click_sound_enabled`      | Click sounds toggle.                                     |
| `weave_variables`                  | Session-wide variables list (`[{ name, type }]`) attached to every survey created. Edited via the **Variables** card. |
| `weave_llm_keys`                   | Opt-in per-provider LLM API key cache (`{ openai, anthropic, gemini }`). Populated only when the user ticks "Remember this key in this browser" in the **Format using LLM** modal. Default OFF. Never sent to the SurveySparrow API; only used by the user's own LLM provider. |

`sessionStorage.plumage_first_success` gates the one-time celebration sound + confetti per session.

---

## Known limitations

- **Display logic** is experimental — simple `Show if: Q3 equals Yes` rules work; complex branching is ignored.
- **NPSFeedback / CESFeedback / CSATFeedback** are allowed only in the matching survey type, and only one per survey, directly after the score question. Stray feedback Qs are silently downgraded to Long text.
- **File / image / audio / signature** questions are created as their proper types; bring the actual respondent uploads through SurveySparrow's UI after import.
- **Always review the generated draft** in SurveySparrow before sharing with respondents.

---

## Contributing

Issues and PRs welcome. Please run `npm run typecheck` before opening a PR. Keep the frontend dependency-free (vanilla JS only) — if you need a bundler or framework, raise an issue to discuss first.
