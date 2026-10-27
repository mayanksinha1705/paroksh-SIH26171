# PAROKSH — Privacy-preserving On-device Representation for Knowledge & Screen Handling

**Smart India Hackathon 2026 — Problem Statement 26171**
*On-device Visual Perception for Light-weight Browser Agents*

**Team:** Laptop Dega Dhokha · **Team ID:** 189378 · **Theme:** Smart Automation · **Category:** Software · **Organization:** ISRO

PAROKSH is a Chrome extension (Manifest V3) that lets an AI agent operate a browser — observing the screen, deciding what to do, and executing actions — while enforcing a privacy boundary inside the browser itself. Sensitive information is detected and redacted locally, using on-device vision and language models, before anything reaches the reasoning layer. The AI never receives the raw screen; it receives only the context the browser allows it to see.

> **Scope:** current build targets Chrome (MV3). It uses the `offscreen`, `debugger`, and `chrome.tabs.captureVisibleTab` APIs and does not yet run in Firefox.

---

## Table of Contents

- [Core Idea](#core-idea)
- [Architecture](#architecture)
- [Agent Loop](#agent-loop)
- [Technology Layer](#technology-layer)
- [PrivacyShield: What Gets Detected and How](#privacyshield-what-gets-detected-and-how)
- [Task-Scoped Token Vault](#task-scoped-token-vault)
- [Session Audit Dashboard](#session-audit-dashboard)
- [Validation](#validation)
- [Comparison with Conventional Browser Agents](#comparison-with-conventional-browser-agents)
- [Repository Structure](#repository-structure)
- [Setup](#setup)
- [Usage](#usage)
- [Research & References](#research--references)
- [Team](#team)

---

## Core Idea

Browser-operating AI agents typically need to see the screen — a screenshot, a DOM dump, or both — before a server-side model can decide what to do next. That screen can contain passwords, Aadhaar numbers, phone numbers, addresses, and other private data, all of which would otherwise leave the device on every single step.

PAROKSH puts a **privacy boundary inside the browser**: a local pipeline (PrivacyShield) understands *where things are* on the screen and redacts *what they contain* before any network request is built. The remote model reasons over sanitized structure, not raw content, and every action it proposes is validated locally before the browser executes it.

> "The AI does not receive the raw screen — only the context the browser allows it to see."

---

## Architecture

```
                    LOCAL — BROWSER                                    SERVER — AI REASONING
┌───────────┐   ┌────────────┐   ┌──────────────┐   ┌───────────┐  ┊  ┌────────────┐   ┌──────────────┐
│ User Goal │──►│ Screen+DOM │──►│ PrivacyShield│──►│ Sanitized │  ┊  │AI Reasoning│──►│Structured    │
│"Execute   │   │Observation │   │  OCR · NER   │   │ Context   │  ┊  │(Gemma via  │   │Action (JSON) │
│ task"     │   │            │   │  Patterns    │   │           │  ┊  │ Ollama)    │   │              │
└───────────┘   └────────────┘   │  Face Detect │   └───────────┘  ┊  └────────────┘   └──────┬───────┘
      ▲                          │  DOM Signals │                  ┊                          │
      │                          └──────────────┘         PRIVACY BOUNDARY                     ▼
      │                                                            ┊                  ┌──────────────────┐
      └────────────────────────────────────────────────────────────────────────────── │ Local Validation  │
                                                                                        │ & Execution       │
                                                                                        └──────────────────┘
```

The raw screenshot is processed by PrivacyShield **before** the `/api/action` request is built. The backend only ever receives the sanitized image and context — never the raw screenshot. The browser acts only on commands that pass local validation.

### Problem Addressed

- **Privacy:** sensitive information is sanitized before transmission.
- **Understanding:** OCR, NER, sensitive patterns, contextual field rules, face detection, and DOM signals provide layered perception.
- **Safety:** AI-generated actions are structured and checked locally before execution.

### Innovation

| # | Feature | Description |
|---|---|---|
| 01 | Local Privacy Boundary | The browser — not the server — controls what the AI is allowed to see. |
| 02 | Multi-Layer PrivacyShield | Visual (OCR, face detection), textual (NER, patterns), and DOM-level protection combined. |
| 03 | Controlled Agent Loop | Perceive → Sanitize → Reason → Validate → Act, with every step logged. |
| 04 | Multilingual OCR | Hindi + English on-device text perception. |

---

## Agent Loop

```
Setup once → Observe → Protect → Sanitize → Reason → Validate & Act → Record → Reply
```

**Setup (once per task):**

1. **Task** — the user gives a plain-English browser task.
2. **Receive** — the service worker receives the instruction.
3. **Detect** — sensitive values in the task are found locally.
4. **Vault** — a task-scoped, memory-only vault is created.
5. **Tokenize** — sensitive values are replaced with temporary tokens (`PERSON_1`, `PHONE_1`, `EMAIL_1`, `DOB_1`, …).
6. **Loop starts** — the agent loop begins (capped at 30 steps).

**Agent loop (repeats every step):**

| Step | Name | What happens | Runs on |
|---|---|---|---|
| 01 | Observe | Reads the active tab and DOM manifest; hides the PAROKSH panel, captures the viewport, then restores the panel | Browser |
| 02 | Protect | PrivacyShield (offscreen document) runs DOM-rectangle detection, OCR + layout analysis, local NER, and RetinaFace face detection | Browser |
| 03 | Sanitize | Detected regions get local black masks; safe/interactive elements are annotated with temporary IDs | Browser |
| 04 | Reason | The masked task, redacted image, manifest, history, and safe OCR text cross the privacy boundary to a local Node.js backend, which calls Ollama (Gemma 4:31B) and returns one structured JSON action | Backend |
| 05 | Validate & Act | The action is routed by type; a `TYPE` action resolves its token from the vault, the target field is validated, and the action runs locally | Browser |
| 06 | Record | The masked result (tokens, not real values) is saved to history | Browser |
| 07 | Complete? | If done: reply to the user and clear the vault. If not: capture the next screenshot and repeat | Browser / User input |

Only the masked task, redacted image, element manifest, history, and safe OCR text cross the privacy boundary — real values never do.

---

## Technology Layer

| Layer | Technologies |
|---|---|
| **Browser** | Chrome MV3, Service Worker, Offscreen Document |
| **PrivacyShield** | Tesseract.js (OCR), BERT-based NER, ONNX Runtime Web, RetinaFace |
| **Frontend** | React, Tailwind CSS (PAROKSH panel) |
| **Backend** | Local Node.js server, Express, REST |
| **AI Reasoning** | Ollama, Gemma 4:31B |
| **Execution** | Local action executor, memory-only token vault |

PAROKSH separates perception, privacy enforcement, AI reasoning, and browser execution into controlled layers.

---

## PrivacyShield: What Gets Detected and How

All detection and redaction happen **inside the browser**, in an MV3 offscreen document, before the network request is constructed.

| Signal | Technology | Purpose |
|---|---|---|
| OCR | Tesseract.js (WASM), Hindi + English | Reads on-screen text the DOM can't reach (canvas, images) |
| NER | ONNX Runtime Web, BERT-based token classifier | Flags names, locations, organizations |
| Sensitive patterns | Regex | Phone, email, PAN, Aadhaar, card numbers, DOB |
| Face detection | ONNX Runtime Web, RetinaFace | Locates and masks faces |
| DOM signals | JavaScript | Flags password/email/tel/card inputs and field types independent of OCR |

Detected regions are merged; sensitive ones are redacted with local black masks, and safe interactive elements are annotated with temporary IDs so the remote model can reference them without seeing their content.

---

## Task-Scoped Token Vault

Sensitive values the user provides (e.g. "fill in my phone number 98XXXXXXXX") are never sent to the reasoning layer as plain text.

1. At task setup, sensitive values in the instruction are detected locally and stored in a **memory-only vault**, scoped to that task.
2. Each value is replaced with a token (`PERSON_1`, `PHONE_1`, `EMAIL_1`, `DOB_1`, …).
3. Only tokens travel across the privacy boundary — in the instruction, the manifest, and the action history.
4. When the model returns a `TYPE` action referencing a token, the extension resolves it from the vault **locally**, validates the target field, and types the real value.
5. The vault is cleared when the task completes or is stopped.

This means the reasoning layer can direct the agent to fill in sensitive data without ever seeing the data itself.

---

## Session Audit Dashboard

PAROKSH ships an in-browser audit view (`audit.html`) that surfaces what happened during a session, for both debugging and demonstration:

- **Session dashboard:** tasks run, screenshots processed, redacted regions found.
- **Session estimates:** average latency, average memory, average OCR/NER/face-detection time, average paint time, and redactions per screenshot — all derived from measurements collected during the browser session.
- **Redacted screenshots:** a per-step gallery showing what was actually sent, with the detection stages and timings for that step (e.g. "OCR 2130 ms · NER 692 ms · Face 4737 ms · Paint 0 ms").
- **Redaction session view:** a log of completed tasks with a timeline of scroll/click/redaction events per step.

This is the primary evidence surface for the metrics reported below — every figure in the Validation section is traceable back to a session captured this way.

---

## Validation

**Method:** manual audit of a real browser session — **100 screenshots, 356 sensitive entities, across 2 page types** (a college admission form and a Google Form). Each mask box in every screenshot was manually reviewed and classified as a true positive, a false positive (text or non-text), or a miss.

### Headline Metrics

| Metric | Value | Basis |
|---|---|---|
| PII Detection Precision | **92.65%** | 353 correctly masked entities / 28 text over-masks |
| PII Detection Recall | **99.16%** | 353 of 356 sensitive entities detected (3 missed) |
| PII Detection F1 | **95.79%** | Harmonic mean of the precision/recall pair above |
| Redaction Precision | **86.31%** | 353 correct masks out of 409 total mask boxes drawn (includes non-text over-masks, e.g. icons) |
| Visual Context Accuracy | **95%** | Observed correctness of element/field targeting across the audited session |

### Resource & Latency Profile

| Metric | Value | Notes |
|---|---|---|
| RAM | 75–120 MB | JS heap, environment-dependent |
| Model footprint | 331 MB | NER (227 MB) + RetinaFace (104 MB), on-device |
| CPU | ~1 core | Single-threaded WASM execution |
| End-to-end latency (median) | 12.63 s / step | Includes capture, upload, reasoning, execution, and wait |
| End-to-end latency (P90) | 19.17 s / step | |
| Typical 10-step task | ~126 s wall-clock | Component-level timing breakdown is provisional pending further instrumentation |

### Per-Page-Type Breakdown

| Page type | Screenshots | Correct masks | Over-masks (FP) | Leaks (FN) | Precision | Recall |
|---|---|---|---|---|---|---|
| Admission Form | 44 | 286 | 3 | 2 | 99.0% | 99.3% |
| Google Form | 56 | 67 | 53 | 1 | 55.8% | 98.5% |
| **Total** | **100** | **353** | **56** | **3** | **86.3%** | **99.2%** |

Recall stays high across both page types. Precision varies significantly by layout — the admission form (structured, labeled fields) scores far higher than the Google Form (denser, less consistently labeled), indicating that over-masking, not missed detection, is the primary source of error on unfamiliar layouts.

### Feasibility Notes

| Area | Basis |
|---|---|
| Technical | Chrome MV3 + ONNX Runtime Web + Tesseract.js — all standard, browser-supported technologies |
| Operational | Runs entirely in-browser via a controlled agent loop |
| Privacy | Sensitive context is processed and redacted before it reaches the reasoning layer |
| Economic | Open-source components; reasoning can scale server-side independently of the client |

### Challenges Identified → Mitigation Direction

| Challenge | Mitigation direction |
|---|---|
| Visual/inference latency | Crop/resize the viewport before inference |
| ONNX cold start | Pre-warm models at extension load |
| Site/layout variability | Expand DOM grounding and cross-site testing |
| Model footprint | Cache and reuse pipeline instances across steps |
| Data exposure | Continue layering local redaction signals |
| Output variability from the reasoning model | Enforce a strict JSON action schema |

---

## Comparison with Conventional Browser Agents

| Feature | PAROKSH | Conventional Cloud-First Browser Agent |
|---|---|---|
| Local visual processing | Browser-side perception + DOM context | Primarily cloud/server-side |
| Raw screenshot exposure | Processed and redacted before transmission | Depends on implementation |
| Local privacy sanitization | Local OCR, NER, patterns, face & DOM signals | Depends on implementation |
| AI reasoning | Sanitized context only | Typically cloud/server-based on raw content |
| Action execution | Structured actions + local validation | Depends on implementation |
| Architecture | Privacy boundary inside the browser | Cloud-first processing |

---

## Repository Structure

```
paroksh/
├── frontend/
│   ├── manifest.json              # MV3 extension manifest
│   ├── extension-core/
│   │   ├── background.js          # Agent loop, orchestration, vault, history
│   │   ├── content.js             # DOM scan, element manifest, sensitive-rect detection
│   │   └── action-executor.js     # Click / type / scroll / select / navigate / key execution
│   ├── privacy-shield/
│   │   ├── pipeline.js            # Orchestrates OCR → NER → regex → face → redraw
│   │   ├── offscreen.js           # MV3 offscreen document entry point
│   │   ├── audit.html             # Session audit dashboard
│   │   ├── lib/
│   │   │   ├── ocr.js             # Tesseract.js wrapper
│   │   │   ├── ner.js             # ONNX NER inference
│   │   │   ├── entities.js        # Regex / pattern detectors
│   │   │   ├── sensitive.js       # Merges detections, assigns block/review
│   │   │   ├── face-detector.js   # RetinaFace inference
│   │   │   ├── redact.js          # Canvas redaction
│   │   │   └── image.js / cache.js
│   │   └── evaluation/
│   │       └── evaluate.mjs       # Offline evaluation harness
│   └── popup-src/                 # React popup UI
├── backend/
│   ├── server.js                  # Express server, /api/action, /api/reply
│   ├── ollama/
│   │   └── ollama.js              # Ollama client (Gemma 4:31B)
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

On first load, the extension downloads the local ONNX models into the offscreen document.

---

## Usage

1. Navigate to the page you want the agent to operate on.
2. Open the PAROKSH panel and describe the task in plain English (e.g. *"Fill in the personal details section"*).
3. The agent observes, redacts, reasons, validates, and acts — one step at a time — until the task is complete or stopped.
4. Open `audit.html` at any point to view the session dashboard: tasks, screenshots, redacted regions, and per-step timing.

---

## Research & References

- NVIDIA Research — Small Language Models: [research.nvidia.com/labs/lpr/slm](https://research.nvidia.com/labs/lpr/slm)
- [arxiv.org/pdf/2506.02153](https://arxiv.org/pdf/2506.02153)
- [zenodo.org/records/20448109](https://zenodo.org/records/20448109)
- Transformers.js — [huggingface.co/docs/transformers.js](https://huggingface.co/docs/transformers.js)
- ONNX Runtime Web — [onnxruntime.ai/docs/tutorials/web](https://onnxruntime.ai/docs/tutorials/web)
- Microsoft OmniParser — [github.com/microsoft/OmniParser](https://github.com/microsoft/OmniParser)

**Code:** [github.com/mayanksinha1705](https://github.com/mayanksinha1705)

---

## Team

**Team PAROKSH — Laptop Dega Dhokha**

| Name | Role |
|---|---|
| Nitesh Kumar Sahu | Team Leader |
| Antra Singh | Member |
| Mayank Sinha | Member |
| Abhimanyu Sahu | Member |
| Adarsh Sharma | Member |
| Uday Yadav | Member |

---

## Problem Statement Reference

**ID:** SIH26171 · **Title:** On-device Visual Perception for Light-weight Browser Agents · **Organization:** Indian Space Research Organisation (ISRO) · **Category:** Software · **Theme:** Smart Automation
