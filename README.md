# PAROKSH — Privacy-First Vision-AI Browser Agent

**Smart India Hackathon — Problem Statement 26171**
*On-device Visual Perception for Light-weight Browser Agents*

PAROKSH is a Chrome extension that lets an AI agent operate your browser — click, type, scroll, navigate, and fill forms — toward a goal described in plain English, while keeping personally identifiable information (PII) on the device. A local vision-and-language pipeline detects and redacts sensitive content in a screenshot *before* it ever leaves the browser; only the sanitized image and a redacted DOM manifest are sent to a server-side model, which returns structured actions for the extension to execute.

> **Scope note:** the current build targets Chrome (Manifest V3). It relies on the `offscreen`, `debugger`, and `chrome.tabs.captureVisibleTab` APIs, so it does not yet run in Firefox.

---

## Table of Contents

- [Why This Exists](#why-this-exists)
- [Architecture](#architecture)
- [Privacy Pipeline](#privacy-pipeline)
- [What Counts as Sensitive](#what-counts-as-sensitive)
- [Data Flow — What Leaves the Browser](#data-flow--what-leaves-the-browser)
- [Repository Structure](#repository-structure)
- [Setup](#setup)
- [Usage](#usage)
- [Evaluation Metrics](#evaluation-metrics)
- [Known Limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Security Notes](#security-notes)
- [Team](#team)

---

## Why This Exists

Browser-operating AI agents typically need to "see" the screen — usually as a full-resolution screenshot or a raw accessibility-tree dump — before a server-side model can decide what to do next. On a form full of Aadhaar numbers, phone numbers, addresses, or a webmail inbox, that means private data leaves the device on every single step, even when the agent's actual job (click this, scroll there, fill that field) never required seeing the value at all.

PAROKSH separates *understanding where things are* from *knowing what they contain*. A lightweight local pipeline reads the screen, figures out which regions are sensitive, and blacks them out before any network call is made. The remote model reasons over structure, not content.

---

## Architecture

```
Screen
  │
  ├─► DOM Scan (content.js)
  │     • Enumerates interactive elements (buttons, inputs, links)
  │     • Classifies fields by type / autocomplete / label
  │     • Locates DOM-detectable sensitive rectangles (password, email,
  │       tel, card-autocomplete, PAN text nodes)
  │
  ├─► Screenshot Capture (chrome.tabs.captureVisibleTab)
  │
  ▼
Offscreen Document — PrivacyShield Pipeline
  │
  ├─► OCR (Tesseract.js, WASM, hin+eng)
  ├─► NER (ONNX Runtime Web, MuRIL token-classification model)
  ├─► Regex / pattern detectors (phone, email, PAN, Aadhaar, card, etc.)
  ├─► Face detection (RetinaFace, ONNX Runtime Web)
  ├─► DOM-derived rectangles (from content.js)
  │
  ▼
Redaction — merge all detected regions, black out "block"-level items,
             draw numbered Set-of-Mark boxes for interactive elements
  │
  ▼
POST /api/action  →  { redacted image (JPEG), safeText, element manifest,
                        action history, user instruction }
  │
  ▼
Node.js Backend  →  Ollama (Gemma, cloud-hosted) interprets the sanitized
                     context and returns a structured JSON action
  │
  ▼
Agent Loop (background.js) → Action Executor → DOM action (click / type /
                              scroll / select / navigate / key)
```

---

## Privacy Pipeline

All detection and redaction run **inside the browser**, in an MV3 offscreen document, before the network request is constructed.

| Stage | Technology | Runs on | Purpose |
|---|---|---|---|
| Text extraction | Tesseract.js (WASM) | Client | Reads on-screen text the DOM scan can't reach (canvas, images) |
| Named-entity recognition | ONNX Runtime Web, MuRIL-based token classifier | Client | Flags names, locations, organizations in OCR text |
| Pattern detection | Regex | Client | Phone, email, PAN, Aadhaar, card numbers, IFSC, DOB |
| Field-label rules | Heuristic | Client | Associates a detected value with its field label |
| Face detection | ONNX Runtime Web, RetinaFace | Client | Locates and masks faces in profile photos |
| DOM classification | JavaScript | Client | Flags password/email/tel/card inputs and non-empty text fields by type, independent of OCR |
| Redaction | Canvas | Client | Draws solid black rectangles over every flagged region |

Execution provider is currently `wasm` only (no WebGPU acceleration yet — see [Roadmap](#roadmap)).

---

## What Counts as Sensitive

PAROKSH separates sensitivity into tiers so that redaction coverage and rationale are explicit rather than implicit.

| Tier | Examples | Treatment |
|---|---|---|
| **Direct identifiers** | Name, phone, email, address, city/state/PIN, DOB, Aadhaar, PAN, card number, face | Always redacted |
| **Special-category attributes** | Religion, caste/category | Redacted |
| **Configurable attributes** | Blood group, income, health information | Redacted if enabled in policy |
| **Low-risk attributes** | Nationality, mother tongue, occupation, academic marks | Left visible by default — the agent needs to read some fields to act correctly, and over-redaction blinds it unnecessarily |
| **Credentials & secrets** | Passwords, OTPs, CVV, API keys, tokens | Never sent to the model in any form |

This policy is intentionally explicit and adjustable — see [`docs/sensitivity-policy.md`](#) *(to be added)* for the full table and rationale per class.

---

## Data Flow — What Leaves the Browser

| Channel | Content | Sanitization |
|---|---|---|
| Screenshot | Redacted JPEG | Full pipeline above |
| `safeText` | OCR text with blocked spans replaced by placeholders | Full pipeline above |
| Element manifest | Interactive elements, DOM-derived labels | Regex-based only *(see Known Limitations)* |
| Action history | Prior actions, including previously typed text | Regex-based only |
| User instruction | The task description, verbatim | **Not currently sanitized** |

---

## Repository Structure

```
paroksh/
├── frontend/
│   ├── manifest.json              # MV3 extension manifest
│   ├── extension-core/
│   │   ├── background.js          # Agent loop, orchestration, history
│   │   ├── content.js             # DOM scan, element manifest, sensitive-rect detection
│   │   └── action-executor.js     # Click / type / scroll / select / navigate / key execution
│   ├── privacy-shield/
│   │   ├── pipeline.js            # Orchestrates OCR → NER → regex → face → redraw
│   │   ├── offscreen.js           # MV3 offscreen document entry point
│   │   ├── lib/
│   │   │   ├── ocr.js             # Tesseract.js wrapper
│   │   │   ├── ner.js             # ONNX NER inference
│   │   │   ├── entities.js        # Regex / pattern detectors
│   │   │   ├── sensitive.js       # Merges detections, assigns block/review
│   │   │   ├── face-detector.js   # RetinaFace inference
│   │   │   ├── redact.js          # Canvas redaction
│   │   │   └── image.js / cache.js
│   │   └── evaluation/
│   │       └── evaluate.mjs       # Offline evaluation harness (in progress)
│   └── popup-src/                 # React popup UI
├── backend/
│   ├── server.js                  # Express server, /api/action, /api/reply
│   ├── ollama/
│   │   └── ollama.js              # Ollama client (Gemma, cloud-hosted)
│   └── temp/                      # Saved redacted screenshots (debug/demo only)
└── README.md
```

---

## Setup

### Prerequisites
- Google Chrome (or Chromium-based browser) with MV3 support
- Node.js ≥ 18
- [Ollama](https://ollama.com) installed locally, with access to the configured Gemma model

### Backend

```bash
cd backend
npm install
node server.js
# Server listens on http://localhost:3000
```

### Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `frontend/` directory
4. Pin the PAROKSH icon to the toolbar

On first load, the extension downloads the local ONNX models into the offscreen document. This can take longer on the first run.

---

## Usage

1. Navigate to the page you want the agent to operate on.
2. Open the PAROKSH panel and type an instruction, e.g. *"Fill in the personal details section"* or *"Scroll to the document upload section."*
3. The agent will capture the screen, redact sensitive regions locally, send only the sanitized context to the server, and execute the returned action.
4. Each step is shown in the pipeline trace panel (capture → redact → model → execute).

---

## Evaluation Metrics

| Metric | PS weight | Status |
|---|---|---|
| Visual context accuracy | 25% | **Not yet measured** — requires a labeled test set with expected element/action ground truth |
| PII detection precision / recall | 20% | **Not yet measured** — requires a labeled set of screenshots with ground-truth PII spans and bounding boxes; see [`evaluation/`](frontend/privacy-shield/evaluation/) |
| Redaction precision | 20% | **Not yet measured** |
| Client-side resource utilization | 20% | **Not yet measured** — memory, CPU, and GPU/WebGPU usage during inference |
| End-to-end latency | 15% | **Not yet measured** — per-stage timing instrumentation in progress |

We are deliberately not publishing placeholder numbers. Figures will be added here once measured on a proper labeled test set (with clean/negative examples included to report false-positive rate), with the methodology stated alongside each number.

---

## Known Limitations

Documented honestly so reviewers and the team can track progress against them.

- **Instruction and history channels are not fully sanitized.** The user's raw instruction, and previously typed values in action history, currently reach the server outside the image pipeline. A token/placeholder scheme (real values resolved locally, never sent to the model) is planned — see Roadmap.
- **No local validation of returned actions.** The extension currently checks only that a returned action's verb is in an allow-list; it does not yet enforce origin restrictions or require confirmation before high-risk actions (submit, delete, navigation, typing into sensitive fields).
- **No WebGPU acceleration.** All ONNX inference currently runs on the `wasm` execution provider.
- **Single-page test coverage.** The pipeline has primarily been exercised against one sample form; behavior on other layouts and sites (email, dashboards, multi-frame pages) is not yet systematically verified.
- **Firefox is not supported.**
- **Uploaded-file names are not sanitized** — a filename containing PII (e.g. `aadhaar_<name>.pdf`) can appear unredacted in a captured screenshot.

---

## Roadmap

| Priority | Item |
|---|---|
| P0 | Sanitize the instruction and action-history channels using the existing local detectors |
| P0 | Build a labeled evaluation set (positive + negative/clean examples) and populate the metrics table above |
| P0 | Add per-stage latency, memory, and resource instrumentation |
| P1 | Local placeholder/vault scheme: sensitive values resolved from an on-device profile and substituted into actions at execution time, never sent to the server |
| P1 | Local action-validation layer (origin allow-list, confirmation before submit/delete/sensitive-field typing) |
| P1 | WebGPU execution provider with WASM fallback |
| P2 | Firefox support |
| P2 | In-extension activity dashboard (redaction coverage, latency breakdown, session history) |

---

## Security Notes

- Sanitized context is sent to a Gemma model via Ollama; when using a cloud-hosted Ollama model, this data leaves the local machine (though it has already been through the redaction pipeline). Purely offline model deployment is supported by swapping the Ollama endpoint/model.
- The backend currently saves every received (redacted) screenshot to `backend/temp/` for debugging. This should be disabled by default outside of development/demo use.
- Any saved user profile data (planned, see Roadmap) will be stored using `chrome.storage.local`/`chrome.storage.session`, isolated from web page contexts. It is not currently encrypted at rest.

---

## Team

*(Add team name, members, and mentor acknowledgment here.)*

---

## Problem Statement Reference

**ID:** 26171 · **Organization:** Indian Space Research Organisation (ISRO) · **Category:** Software · **Theme:** Smart Automation
