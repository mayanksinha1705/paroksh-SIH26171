// ---------------------------------------------------------------------------
// Model access
//
// The Gemma action model and the chat model used to be imported straight into
// this service worker from ../ollama/. They now live in the Node backend
// (backend/server.js), because a service worker can only import files from
// inside the extension folder — and because the model layer has no business
// running in the browser at all.
//
// These two wrappers keep the exact same signatures the rest of this file
// already expects, so nothing below had to change.
// ---------------------------------------------------------------------------

const BACKEND_URL = "http://localhost:3000";

async function getActionFromGemma(instruction, imageBase64, history = [], elements = [], safeText = "", signal, metrics = {}) {
  const uploadStarted = performance.now();
  const response = await fetch(`${BACKEND_URL}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, imageBase64, history, elements, safeText, metrics: { ...metrics, uploadMs: performance.now() - uploadStarted } }),
    signal,
  });
  console.log("[PAROKSH timing]", JSON.stringify({
    stage: "upload",
    uploadMs: performance.now() - uploadStarted,
    metrics,
  }));

  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = await response.json();
      if (body?.error) detail = body.error;
    } catch {
      // non-JSON error body; the status code is all we have
    }
    throw new Error(`PAROKSH backend error: ${detail}`);
  }

  const payload = await response.json();
  if (!payload?.action) throw new Error("PAROKSH backend returned no action.");
  return payload.action;
}

/**
 * Mirrors the old ollama2.js contract: never throws, so the user is never
 * shown nothing at all. If the backend is down we still produce a readable
 * sentence rather than dropping the reply.
 */
async function getHumanReply(instruction, rawLog, success = true) {
  try {
    const response = await fetch(`${BACKEND_URL}/api/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: sanitizeText(instruction), rawLog: sanitizeText(rawLog), success }),
    });
    if (!response.ok) throw new Error(`Backend reply error: ${response.status}`);
    const payload = await response.json();
    if (!payload?.reply) throw new Error("Empty reply from backend");
    return payload.reply;
  } catch (err) {
    console.warn("PAROKSH: backend chat reply failed, using fallback:", err.message);
    if (success) {
      const lastStep = String(rawLog || "").split("→").pop().trim();
      return `Done — ${lastStep || "that's finished"}. Anything else you'd like me to do?`;
    }
    return `I ran into a problem: ${rawLog || "something went wrong"}. Want me to try a different approach?`;
  }
}

const ALLOWED_ACTIONS = ["CLICK", "TYPE", "SCROLL", "SELECT", "NAVIGATE", "HOVER", "KEY", "DONE", "ERROR"];
// Keep more visual detail for the vision model while retaining a bounded
// request size. The backend accepts up to 32 MB of JSON.
const MAX_SCREENSHOT_DIMENSION = 1600;
const JPEG_QUALITY = 0.95;
const MAX_STEPS = 30;

const SENSITIVE_TEXT_RULES = [
  { pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, replacement: "[EMAIL]" },
  { pattern: /\+?(?:\d[\s-]?){10,15}/gu, replacement: "[PHONE]" },
  { pattern: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, replacement: "[SSN]" },
  { pattern: /\b(?:\d{4}[\s-]?){3}\d{2,7}\b/g, replacement: "[CARD]" },
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/gi, replacement: "[PAN]" },
  { pattern: /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/g, replacement: "[AADHAAR]" },
  { pattern: /\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})\b/g, replacement: "[DOB]" },
];

function sanitizeText(value) {
  let text = String(value ?? "");
  for (const rule of SENSITIVE_TEXT_RULES) text = text.replace(rule.pattern, rule.replacement);
  return text;
}

const VAULT_PATTERNS = [
  { label: "EMAIL", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu },
  { label: "AADHAAR", pattern: /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/gu },
  { label: "CARD", pattern: /\b(?:\d{4}[\s-]?){3}\d{2,7}\b/g },
  { label: "SSN", pattern: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g },
  { label: "PAN", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/giu },
  { label: "PHONE", pattern: /\+?(?:\d[\s-]?){10,15}/gu },
  { label: "DOB", pattern: /\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2})\b/g },
];

function createSensitiveVault() {
  return { values: new Map(), tokens: new Map(), counters: new Map() };
}

function tokenFor(vault, label, value) {
  const normalized = String(value).trim();
  const key = `${label}:${normalized.toLowerCase()}`;
  const existing = vault.tokens.get(key);
  if (existing) return existing;
  const next = (vault.counters.get(label) || 0) + 1;
  const token = `[${label}_${next}]`;
  vault.counters.set(label, next);
  vault.tokens.set(key, token);
  vault.values.set(token, normalized);
  return token;
}

function maskSensitiveInstruction(instruction) {
  const vault = createSensitiveVault();
  let text = String(instruction ?? "");
  for (const { label, pattern } of VAULT_PATTERNS) {
    text = text.replace(pattern, (value) => tokenFor(vault, label, value));
  }
  text = text.replace(
    /\b(?:fill|enter|type|put)\s+([A-Za-z][A-Za-z.'-]*(?:[ \t]+[A-Za-z][A-Za-z.'-]*){0,3})[ \t]+in(?:to)?[ \t]+(student[ \t]+name|evaluator[ \t]+name|full[ \t]+name|name)\b/giu,
    (match, value, label) => `${match.slice(0, match.indexOf(value))}${tokenFor(vault, "PERSON", value)}${match.slice(match.indexOf(value) + value.length, match.length - label.length)}${label}`,
  );
  text = text.replace(
    /\b(student[ \t]+name|evaluator[ \t]+name|full[ \t]+name|name)[ \t]*(?:[:=\-–—][ \t]*)+([A-Za-z][A-Za-z.'-]*(?:[ \t]+[A-Za-z][A-Za-z.'-]*){0,3})(?=[ \t]*(?:\r?\n|,|;|$))/giu,
    (match, label, value) => `${label}${match.slice(label.length, match.indexOf(value))}${tokenFor(vault, "PERSON", value)}`,
  );
  text = text.replace(
    /\b(full[ \t]+name|name)[ \t]*(?:[:=\-–—][ \t]*)?([A-Za-z][A-Za-z.'-]*(?:[ \t]+[A-Za-z][A-Za-z.'-]*){0,3})(?=[ \t]*(?:,|;|\band\b|\bphone\b|\bemail\b|\baddress\b|$))/giu,
    (match, label, value) => `${label}${match.slice(label.length, match.indexOf(value))}${tokenFor(vault, "PERSON", value)}`,
  );
  text = text.replace(
    /\b((?:street[ \t]+address)|(?<!email )(?<!email\t)address)\s*[:=]\s*(?!\[[A-Z]+_\d+\])([^,;\r\n]+)(?=\s*(?:,|;|\band\b|$))/giu,
    (match, label, separatorAndValue) => {
      return `${label}: ${tokenFor(vault, "ADDRESS", separatorAndValue.trim())}`;
    },
  );
  return { text, vault };
}

function resolveVaultTokens(action, elements = []) {
  if (!currentTask || action.action !== "TYPE" || typeof action.text !== "string") return action;
  const tokenPattern = /\[([A-Z]+)_\d+\]/g;
  const target = action.element_id != null
    ? elements.find((element) => element.id === action.element_id)
    : null;
  const tokenLabels = new Set();
  let matched = false;
  const text = action.text.replace(tokenPattern, (token) => {
    matched = true;
    const tokenLabel = token.match(/^\[([A-Z]+)_\d+\]$/)?.[1];
    tokenLabels.add(tokenLabel);
    const value = currentTask.vault?.values.get(token);
    if (value == null) throw new Error(`Unknown sensitive placeholder ${token}.`);
    return value;
  });
  if (!matched) return action;
  if (tokenLabels.size !== 1) {
    throw new Error("A TYPE action may contain one sensitive placeholder category at a time.");
  }
  const [tokenLabel] = tokenLabels;
  const tokenNumber = Number(action.text.match(/\[[A-Z]+_(\d+)\]/)?.[1]);
  const actionTarget = String(action.target || "").toLowerCase();
  const targetCategoryMatches = {
    PERSON: /\b(person|name|student|evaluator|father|mother)\b/u,
    PHONE: /\b(phone|mobile|telephone|tel|contact)\b/u,
    EMAIL: /\b(email|e-mail|mail)\b/u,
    PAN: /\bpan\b/u,
    AADHAAR: /\b(aadhaar|aadhar|uidai)\b/u,
    DOB: /\b(dob|birth|birthday|date\s+of\s+birth)\b/u,
    ADDRESS: /\b(address|street|residence|postal)\b/u,
    CARD: /\b(card|credit|debit|cvv)\b/u,
  };
  const categoryMatches = (element, category) => {
    if (!element) return false;
    if (element.category === category) return true;
    const descriptor = `${element.label || ""} ${element.autocomplete || ""} ${element.type || ""}`.toLowerCase();
    const categoryPatterns = {
      PERSON: /\b(person|name|student|evaluator|father|mother)\b/u,
      PHONE: /\b(phone|mobile|telephone|tel|contact)\b/u,
      EMAIL: /\b(email|e-mail|mail)\b/u,
      PAN: /\bpan\b/u,
      AADHAAR: /\b(aadhaar|aadhar|uidai)\b/u,
      DOB: /\b(dob|birth|date)\b/u,
      ADDRESS: /\b(address|street|residence|postal)\b/u,
      CARD: /\b(card|credit|debit|cvv)\b/u,
    };
    return categoryPatterns[category]?.test(descriptor) === true;
  };
  const targetMatchesToken = categoryMatches(target, tokenLabel);
  const targetTextMatchesToken = targetCategoryMatches[tokenLabel]?.test(actionTarget) === true;
  if (target && !targetMatchesToken && targetTextMatchesToken) {
    return { ...action, text };
  }
  if (!targetMatchesToken && targetTextMatchesToken) {
    const candidates = elements.filter((element) => (
      categoryMatches(element, tokenLabel)
      || ["INPUT", "TEXTAREA", "TEXTBOX"].includes(String(element.tag || "").toUpperCase())
    ));
    const indexedCandidate = Number.isInteger(tokenNumber) ? candidates[tokenNumber - 1] : null;
    if (indexedCandidate) {
      return { ...action, element_id: indexedCandidate.id, text };
    }
    if (candidates.length === 1) {
      return { ...action, element_id: candidates[0].id, text };
    }
  }
  if (!targetMatchesToken && action.target) {
    const targetText = String(action.target).toLowerCase();
    const targetByLabel = elements.find((element) => (
      categoryMatches(element, tokenLabel)
      && String(element.label || "").toLowerCase().includes(targetText)
    ));
    if (targetByLabel) {
      return { ...action, element_id: targetByLabel.id, text };
    }
  }
  if (!targetMatchesToken) {
    const matchingFields = elements.filter((element) => categoryMatches(element, tokenLabel));
    const indexedField = Number.isInteger(tokenNumber) ? matchingFields[tokenNumber - 1] : null;
    if (indexedField) {
      return { ...action, element_id: indexedField.id, text };
    }
    if (matchingFields.length !== 1) {
      const targetDescription = target?.category
        ? `${target.category} field #${action.element_id}`
        : "the selected field";
      throw new Error(`Sensitive placeholder [${tokenLabel}_1] cannot be matched to a visible ${tokenLabel} field; scroll until that field is visible.`);
    }
    return { ...action, element_id: matchingFields[0].id, text };
  }
  return { ...action, text };
}

function sanitizeForModel(value) {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeForModel);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeForModel(item)]));
  }
  return value;
}

function sanitizeHistory(history) {
  return sanitizeForModel(history).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const sanitized = { ...entry };
    if (Object.prototype.hasOwnProperty.call(sanitized, "text")) {
      sanitized.text = "[REDACTED_INPUT]";
    }
    return sanitized;
  });
}

function sanitizeManifest(elements) {
  return sanitizeForModel(elements).map((element) => {
    if (!element || typeof element !== "object" || Array.isArray(element)) return element;
    const { innerText, textContent, value, label, name, placeholder, title, ...safeElement } = element;
    return {
      id: safeElement.id,
      tag: safeElement.tag,
      role: safeElement.role || "",
      type: safeElement.type || "",
      autocomplete: safeElement.autocomplete || "",
      label: label && /^\[(?:PERSON|PAN|AADHAAR|DOB|EMAIL|PHONE|CARD|ADDRESS|PASSWORD)\]$/i.test(label)
        ? label.toUpperCase()
        : `[${String(safeElement.role || safeElement.tag || "ELEMENT").toUpperCase()}]`,
      category: label && /^\[(?:PERSON|PAN|AADHAAR|DOB|EMAIL|PHONE|CARD|ADDRESS|PASSWORD)\]$/i.test(label)
        ? label.slice(1, -1).toUpperCase()
        : "UNKNOWN",
      x: safeElement.x,
      y: safeElement.y,
      width: safeElement.width,
      height: safeElement.height,
    };
  });
}

function normalizeAction(rawAction) {
  if (!rawAction || typeof rawAction !== "object") {
    throw new Error("Action model returned an invalid action.");
  }
  const action = { ...rawAction };
  action.action = String(action.action || "").trim().toUpperCase();
  if (action.element_id != null && action.element_id !== "") {
    const elementId = Number(action.element_id);
    action.element_id = Number.isInteger(elementId) ? elementId : action.element_id;
  }
  if (!ALLOWED_ACTIONS.includes(action.action)) {
    throw new Error(`Unsupported action returned by model: ${action.action || "empty"}`);
  }
  if (action.action === "SCROLL") {
    const amount = typeof action.amount === "string"
      ? Number.parseFloat(action.amount)
      : Number(action.amount);
    action.amount = Number.isFinite(amount) ? Math.min(Math.max(Math.abs(amount), 0), 2000) : 500;
    action.direction = String(action.direction || "down").toLowerCase() === "up" ? "up" : "down";
  }
  return action;
}

// Purely a display label for the live pipeline status feed below — the
// actual model name lives in backend/ollama/ollama.js's MODEL constant.
// Keep these in sync if that ever changes.
const GEMMA_MODEL_LABEL = "gemma4:31b-cloud";

// ---------------------------------------------------------------------------
// Live pipeline status broadcast
//
// Fire-and-forget: chrome.runtime.sendMessage() with no target reaches every
// currently-open extension page, which includes the floating panel's iframe
// (frontend/popup.html — see content.js) since that's a real
// chrome-extension:// page with its own chrome.runtime.onMessage listener.
// If the panel is closed there's simply no listener; we swallow that
// (reading chrome.runtime.lastError) rather than let it become console
// noise, and this never affects the actual agent loop either way.
// ---------------------------------------------------------------------------
function broadcastStatus(tabId, stage, label, meta = {}) {
  const runId = currentTask?.tabId === tabId ? currentTask.runId : undefined;
  const event = { type: "PAROKSH_PIPELINE_STATUS", tabId, stage, label, timestamp: Date.now(), runId, ...meta };
  if (currentTask && currentTask.tabId === tabId) {
    currentTask.events.push(event);
    if (currentTask.events.length > TASK_EVENT_HISTORY_LIMIT) currentTask.events.shift();
  }
  try {
    chrome.runtime.sendMessage(event, () => {
      void chrome.runtime.lastError; // no receiver (panel closed) — ignore
    });
  } catch (_err) {
    // Best-effort only; never let a broadcast failure affect the agent loop.
  }
}

// ---------------------------------------------------------------------------
// Panel open/closed state, per tab
//
// A full page navigation (the user clicking a link, or the agent itself
// issuing a NAVIGATE action) tears down and re-injects the content script,
// which wipes out whatever the old content script had put in the DOM —
// including our floating panel. To make the panel survive navigation, we
// remember whether it was open per-tab in chrome.storage.session, and the
// freshly-loaded content script checks that on startup and re-opens itself
// if it should still be open. Explicitly closing the panel (the ✕ button)
// clears the flag so it stays closed on subsequent navigations.
// ---------------------------------------------------------------------------

const PANEL_TABS_KEY = "paroksh_panel_open_tabs";

// ---------------------------------------------------------------------------
// Task state — survives the popup panel being torn down and recreated by a
// page navigation mid-task.
//
// The floating panel is an <iframe> injected by the content script (see
// content.js); a full page navigation (the agent's own NAVIGATE action, or
// just clicking a link) destroys that iframe's whole JS realm and content.js
// re-injects a brand new one. That fresh React app mounts with isBusy=false
// by default — it has no way to know a task is still running in THIS
// service worker (which never navigates) unless it asks. currentTask makes
// that possible: it's the source of truth a freshly-mounted panel queries
// via GET_TASK_STATUS, and its `events` array lets that panel replay the
// pipeline trace instead of showing a blank one.
//
// lastResultByTab covers the narrow race where the task finishes in the
// gap between the old panel being destroyed and the new one's listener
// registering — without it, that PAROKSH_TASK_RESULT broadcast would fire
// into an empty page and the final chat reply would simply be lost.
// ---------------------------------------------------------------------------
let currentTask = null; // { runId, tabId, instruction, vault, events: [] }
const lastResultByTab = new Map(); // tabId -> { runId, result, timestamp }
const TASK_EVENT_HISTORY_LIMIT = 60;
const LAST_RESULT_TTL_MS = 15000;

function startTask(runId, tabId, instruction, vault) {
  currentTask = { runId, tabId, instruction, vault, events: [] };
}

function endTask(runId) {
  if (currentTask?.runId === runId) currentTask = null;
}

function broadcastTaskResult(tabId, runId, result) {
  if (tabId != null) {
    lastResultByTab.set(tabId, { runId, result, timestamp: Date.now() });
  }
  try {
    chrome.runtime.sendMessage(
      { type: "PAROKSH_TASK_RESULT", tabId, runId, ...result },
      () => { void chrome.runtime.lastError; } // no listener yet — fine, see lastResultByTab
    );
  } catch (_err) {
    // Best-effort only.
  }
}

// The extension only ever runs one instruction at a time (single popup),
// so a single module-level controller is enough to let a STOP_INSTRUCTION
// message cancel whatever EXECUTE_INSTRUCTION run is currently in flight.
let currentAbortController = null;

async function getOpenPanelTabs() {
  const res = await chrome.storage.session.get(PANEL_TABS_KEY);
  return res[PANEL_TABS_KEY] || {};
}

async function setPanelOpen(tabId, open) {
  const tabs = await getOpenPanelTabs();
  if (open) tabs[tabId] = true;
  else delete tabs[tabId];
  await chrome.storage.session.set({ [PANEL_TABS_KEY]: tabs });
}

async function isPanelOpen(tabId) {
  const tabs = await getOpenPanelTabs();
  return !!tabs[tabId];
}

chrome.tabs.onRemoved.addListener((tabId) => {
  setPanelOpen(tabId, false);
  chrome.storage.session.remove(`paroksh_chat_${tabId}`);
});

// Clicking the toolbar icon opens/closes the floating, draggable in-page
// panel (injected by the content script) instead of a classic popup.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  const nextOpen = !(await isPanelOpen(tab.id));
  await setPanelOpen(tab.id, nextOpen);
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: nextOpen ? "OPEN_PANEL" : "CLOSE_PANEL",
      tabId: tab.id,
    });
  } catch (err) {
    // Content script isn't present on this page (e.g. chrome:// or the
    // Chrome Web Store) — nothing we can inject into.
    console.warn("PAROKSH: could not reach content script on this tab:", err.message);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    // This message is intended exclusively for the PrivacyShield offscreen document
    return false;
  }
  if (message?.type === "GET_PANEL_STATE") {
    const tabId = sender.tab?.id;
    isPanelOpen(tabId).then((open) => sendResponse({ open, tabId }));
    return true;
  }
  if (message?.type === "PANEL_CLOSED") {
    if (sender.tab?.id != null) setPanelOpen(sender.tab.id, false);
    return false;
  }
  if (message?.type === "EXPORT_REDACTED_IMAGES") {
    (async () => {
      try {
        await setupOffscreenDocument();
        chrome.runtime.sendMessage(
          { target: "offscreen", type: "PRIVACY_SHIELD_GET_VAULT" },
          async (res) => {
            const vault = res?.vault || [];
            if (vault.length === 0) {
              sendResponse({ success: true, message: "No redacted images captured in current session yet." });
              return;
            }
            let count = 0;
            for (const item of vault) {
              try {
                await chrome.downloads.download({
                  url: item.dataUrl,
                  filename: `paroksh_redacted/redacted_${item.timestamp}.png`,
                  saveAs: false,
                });
                count++;
              } catch (dlErr) {
                console.warn("Download failed:", dlErr.message);
              }
            }
            sendResponse({ success: true, message: `Exported ${count} redacted images to Downloads/paroksh_redacted.` });
          }
        );
      } catch (err) {
        sendResponse({ success: false, message: `Export failed: ${err.message}` });
      }
    })();
    return true;
  }
  if (message?.type === "OPEN_AUDIT_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("audit.html") })
      .then((tab) => sendResponse({ success: true, tabId: tab.id }))
      .catch((err) => sendResponse({ success: false, message: err.message }));
    return true;
  }
  if (message?.type === "GET_AUDIT_DATA") {
    (async () => {
      try {
        await setupOffscreenDocument();
        const vault = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { target: "offscreen", type: "PRIVACY_SHIELD_GET_VAULT" },
            (res) => resolve(res?.vault || []),
          );
        });
        const stored = await chrome.storage.session.get("paroksh_audit_tasks");
        sendResponse({ success: true, tasks: stored.paroksh_audit_tasks || [], screenshots: vault });
      } catch (err) {
        sendResponse({ success: false, message: err.message });
      }
    })();
    return true;
  }
  if (message?.type === "STOP_INSTRUCTION") {
    if (currentAbortController) currentAbortController.abort();
    sendResponse({ stopped: true });
    return false;
  }
  if (message?.type === "GET_TASK_STATUS") {
    // Lets a freshly-mounted panel (recreated by a mid-task page
    // navigation — see the comment above currentTask) figure out whether a
    // task is still running and, if so, replay its pipeline trace so far.
    const tabId = sender.tab?.id;
    if (currentTask && (tabId == null || currentTask.tabId === tabId)) {
      sendResponse({ busy: true, runId: currentTask.runId, events: currentTask.events });
      return false;
    }
    // Not busy — but did the task finish in the gap between the old panel
    // being torn down and this one asking? Hand back that result once.
    const cached = tabId != null ? lastResultByTab.get(tabId) : null;
    if (cached && Date.now() - cached.timestamp < LAST_RESULT_TTL_MS) {
      lastResultByTab.delete(tabId);
      sendResponse({ busy: false, finishedResult: { runId: cached.runId, ...cached.result } });
      return false;
    }
    sendResponse({ busy: false });
    return false;
  }
  if (message?.type === "EXECUTE_INSTRUCTION") {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const initiatingTabId = sender.tab?.id ?? null;
    const maskedInstruction = maskSensitiveInstruction(message.instruction);
    chrome.storage.session.get("paroksh_audit_tasks").then((stored) => chrome.storage.session.set({
      paroksh_audit_tasks: [
        ...(stored.paroksh_audit_tasks || []),
        { runId, startedAt: Date.now(), instruction: maskedInstruction.text, status: "running" },
      ].slice(-50),
    }));
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    handleInstruction(maskedInstruction.text, maskedInstruction.vault, signal, runId)
      .then(async (res) => {
        const audit = await chrome.storage.session.get("paroksh_audit_tasks");
        const tasks = (audit.paroksh_audit_tasks || []).map((task) => (
          task.runId === runId
            ? { ...task, completedAt: Date.now(), status: res.success ? "completed" : (res.stopped ? "stopped" : "failed"), message: sanitizeText(res.message) }
            : task
        ));
        await chrome.storage.session.set({ paroksh_audit_tasks: tasks });
        currentAbortController = null;
        // res.message is the raw, mechanical step log (used for the
        // activity log). reply is a separate, human-sounding chat message
        // generated by ollama2.js, so the two never get mixed up.
        const reply = res.stopped
          ? "Okay, I stopped there."
          : await getHumanReply(maskedInstruction.text, sanitizeText(res.message), res.success);
        const finalTabId = currentTask?.tabId ?? initiatingTabId;
        endTask(runId);
        // Broadcast in ADDITION to sendResponse: if a page navigation
        // destroyed the panel that made this call, sendResponse below
        // silently goes nowhere — the broadcast (plus lastResultByTab) is
        // what lets a freshly-mounted panel still learn the outcome.
        broadcastTaskResult(finalTabId, runId, { ...res, reply });
        sendResponse({ ...res, reply });
      })
      .catch(async (err) => {
        currentAbortController = null;
        const audit = await chrome.storage.session.get("paroksh_audit_tasks");
        const tasks = (audit.paroksh_audit_tasks || []).map((task) => (
          task.runId === runId
            ? { ...task, completedAt: Date.now(), status: "failed", message: sanitizeText(err.message) }
            : task
        ));
        await chrome.storage.session.set({ paroksh_audit_tasks: tasks });
        const finalTabId = currentTask?.tabId ?? initiatingTabId;
        if (err.name === "AbortError") {
          const result = {
            success: false,
            stopped: true,
            message: "Stopped by user.",
            reply: "Okay, I stopped there.",
          };
          endTask(runId);
          broadcastTaskResult(finalTabId, runId, result);
          sendResponse(result);
          return;
        }
        if (finalTabId != null) {
          broadcastStatus(finalTabId, "error", `Task failed: ${err.message}`, { error: err.message });
        }
        // Do not send failures through the conversational model. It can turn a
        // precise pipeline error into a misleading explanation about the user's
        // website. The actual error is the useful diagnostic and is already
        // safe to show because it was produced locally by the extension.
        const result = {
          success: false,
          message: err.message || "The task failed before an action could be completed.",
          reply: `I couldn't complete that task: ${sanitizeText(err.message) || "an unknown extension error occurred."}`,
        };
        endTask(runId);
        broadcastTaskResult(finalTabId, runId, result);
        sendResponse(result);
      });
    return true;
  }
  return false;
});

function stoppedResult(results) {
  return {
    success: false,
    stopped: true,
    message: results.join(" → ") + (results.length ? " → " : "") + "Stopped by user.",
  };
}

async function handleInstruction(instruction, vault, signal, runId) {
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active browser tab found.");
  if (runId) startTask(runId, tab.id, instruction, vault);
  const history = [], results = [];
  let lastActionId = null;
  return await runAgentLoop(tab, instruction, signal, history, results, lastActionId);
}

async function runAgentLoop(tab, instruction, signal, history, results, lastActionId) {
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal?.aborted) return stoppedResult(results);
    broadcastStatus(tab.id, "start", `Step ${step + 1}: reading the page…`, { step: step + 1 });
    const rectData = await getElementRects(tab.id);
    if (!rectData.success || rectData.viewportWidth <= 0 || rectData.viewportHeight <= 0) {
      throw new Error(rectData.message || "Could not read the active page. Reload the tab and make sure it is not a chrome:// or extension page.");
    }
    const currentTab = await chrome.tabs.get(tab.id);

    // 1) Capture raw screenshot.
    broadcastStatus(tab.id, "capture", `Step ${step + 1}: capturing screenshot…`, { step: step + 1 });
    const rawShot = await captureRawScreenshot(currentTab.windowId, tab.id);
    const captureMs = rawShot.durationMs;
    if (signal?.aborted) return stoppedResult(results);

    // 2) PRIVACY SHIELD: In-browser PII detection and redaction using ONNX model.
    // The screenshot MUST be sanitized on-device BEFORE it ever leaves the browser.
    broadcastStatus(tab.id, "privacy", `Step ${step + 1}: detecting and black-masking sensitive PII on-device…`, { step: step + 1 });
    const privacyResult = await redactScreenshotWithPrivacyShield(
      rawShot.dataUrl,
      tab.id,
      step + 1,
      rectData
    );
    if (signal?.aborted) return stoppedResult(results);

    const sanitizedDataUrl = privacyResult.dataUrl;
    if (privacyResult.hasRedactions) {
      broadcastStatus(
        tab.id,
        "privacy",
        `Step ${step + 1}: PrivacyShield applied black masks to ${privacyResult.redactedCount} sensitive item(s)`,
        { step: step + 1 }
      );
    } else {
      broadcastStatus(
        tab.id,
        "privacy",
        `Step ${step + 1}: PrivacyShield scan complete — page is privacy-safe`,
        { step: step + 1 }
      );
    }

    // 3) Draw numbered element boxes onto the REDACTED screenshot.
    const shot = await annotateScreenshot(sanitizedDataUrl, rectData);

    if (signal?.aborted) return stoppedResult(results);
    broadcastStatus(tab.id, "gemma", `Step ${step + 1}: sending redacted screenshot to ${GEMMA_MODEL_LABEL}…`, { step: step + 1 });
    const action = normalizeAction(await getActionFromGemma(
      instruction,
      shot.base64,
      sanitizeHistory(history),
      sanitizeManifest(rectData.elements),
      privacyResult.safeText,
      signal
      , { captureMs, ...privacyResult.metrics }
    ));
    broadcastStatus(
      tab.id,
      "gemma",
      `Step ${step + 1}: ${GEMMA_MODEL_LABEL} returned ${action.action}${action.element_id != null ? ` #${action.element_id}` : ""}`,
      { step: step + 1 }
    );

    if (action.action === "DONE") {
      const check = await verifyCompletion(tab.id);
      if (check.isGoogleForm && !check.confirmed) {
        // Model declared victory but the "response has been recorded"
        // confirmation screen isn't showing — this was the exact bug
        // where the agent stopped mid-form. Reject the DONE, tell the
        // model exactly why via history, and keep the loop going instead
        // of reporting a false success.
        history.push({ action: "ERROR", reason: "DONE rejected: form confirmation screen not detected. The form is NOT submitted yet — scroll through the remaining questions, fill anything still empty, then click Submit." });
        results.push("Checked for submission confirmation — not found yet, continuing");
        broadcastStatus(tab.id, "verify", `Step ${step + 1}: DONE rejected — submission not confirmed yet, continuing`, { step: step + 1 });
        continue;
      }
      if (check.hasUnfilledRequired) {
        history.push({ action: "ERROR", reason: "DONE rejected: one or more required fields on the page are still empty or invalid. Fill them before submitting." });
        results.push("Checked required fields — some still empty, continuing");
        broadcastStatus(tab.id, "verify", `Step ${step + 1}: DONE rejected — required fields still empty, continuing`, { step: step + 1 });
        continue;
      }
      broadcastStatus(tab.id, "done", `Task complete: ${action.summary}`, { step: step + 1 });
      return { success: true, message: results.join(" → ") + " → " + action.summary };
    }
    if (action.action === "ERROR") {
      broadcastStatus(tab.id, "error", `Step ${step + 1}: model reported an error — ${action.reason}`, { step: step + 1 });
      throw new Error(action.reason);
    }

    // Repetition Guard: Block clicking the same ID twice in a row
    if (action.action === "CLICK" && action.element_id !== undefined && action.element_id === lastActionId) {
      history.push({ action: "ERROR", reason: "Already clicked this element. Look for new window." });
      continue;
    }

    let result;
    let executableAction;
    try {
      executableAction = resolveVaultTokens(action, rectData.elements);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      history.push({ action: "ERROR", reason });
      results.push(`Blocked unsafe sensitive-field action: ${reason}`);
      broadcastStatus(tab.id, "error", `Step ${step + 1}: ${reason}`, { step: step + 1 });
      continue;
    }
    const executeStarted = performance.now();
    broadcastStatus(
      tab.id,
      "action",
      `Step ${step + 1}: executing ${action.action}${action.element_id != null ? ` on #${action.element_id}` : ""} via Action Executor…`,
      { step: step + 1 }
    );
    if (action.action === "NAVIGATE") {
      result = await executeNavigate(tab.id, action);
      await waitForPageLoad(tab.id);
    } else {
      // DEFAULT PATH: act inside the page — el.click() / value + input/change
      // events by element_id, synthetic key events for KEY — same as the
      // original working extension. It doesn't depend on any screen coordinates and
      // isn't affected by the floating panel sitting on top of the page.
      try {
        result = await executeViaContentScript(tab.id, executableAction);
      } catch (e) {
        // FALLBACK ONLY: real coordinate input through CDP, used when the
        // page-level action asked for it (TRUSTED_INPUT_REQUIRED — e.g.
        // Google Docs canvas) or failed while the model gave x/y.
        const canFallBack = TRUSTED_FALLBACK_ACTIONS.has(action.action) &&
          (e.message === "TRUSTED_INPUT_REQUIRED" || (action.x != null && action.y != null));
        if (!canFallBack) throw e;
        const point = resolveFallbackPoint(executableAction, rectData, currentTab.url);
        if (!point) throw e;
        result = await executeViaTrustedInput(tab.id, executableAction, point);
      }
    }
    const safeResultMessage = action.action === "TYPE"
      ? `Typed ${action.text && /\[[A-Z]+_\d+\]/.test(action.text) ? "sensitive value" : sanitizeText(action.text || "")}`
      : sanitizeText(result.message);
    broadcastStatus(tab.id, "action", `Step ${step + 1}: ${safeResultMessage}`, { step: step + 1 });
    broadcastStatus(tab.id, "timing", `Step ${step + 1} timing`, {
      step: step + 1,
      metrics: { executeMs: performance.now() - executeStarted },
    });

    results.push(safeResultMessage);
    history.push(action);
    lastActionId = (action.action === "CLICK") ? action.element_id : null;
    if (signal?.aborted) return stoppedResult(results);
    await new Promise(r => setTimeout(r, action.action === "CLICK" ? 1500 : 500));
  }
  throw new Error("Max steps reached.");
}

// ---------------------------------------------------------------------------
// Trusted input (Chrome DevTools Protocol) — FALLBACK ONLY
//
// The normal path for every action is executeViaContentScript (act inside
// the page, by element_id). The debugger is used ONLY for a coordinate
// click / type / hover, and only when
//   - the page-level action asks for it (TRUSTED_INPUT_REQUIRED, e.g. typing
//     on Google Docs, which renders to a canvas), or
//   - the page-level action failed and the model supplied x/y.
// KEY presses never use the debugger. It is attached per action and always
// detached again.
// ---------------------------------------------------------------------------

const TRUSTED_FALLBACK_ACTIONS = new Set(["CLICK", "TYPE", "HOVER"]);

// Where to send a fallback coordinate action. On Google Docs/Forms/Sheets the
// prompt tells the model to give x/y (canvas UI, no usable element), so those
// win. Everywhere else the element's own rectangle (computed from the real
// DOM this step) is more reliable than the model's guess from a downscaled
// screenshot, so it is preferred and the model's x/y is only a last resort.
function resolveFallbackPoint(action, rectData, tabUrl) {
  const modelPoint = (action.x != null && action.y != null) ? { x: action.x, y: action.y } : null;
  let onGoogleDocs = false;
  try { onGoogleDocs = new URL(tabUrl).hostname.includes("docs.google.com"); } catch (_e) { /* no url */ }
  if (onGoogleDocs && modelPoint) return modelPoint;
  if (action.element_id != null) {
    const el = rectData?.elements?.find((e) => e.id === action.element_id);
    if (el) return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
  }
  return modelPoint;
}

async function withDebugger(tabId, fn) {
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    return await fn();
  } finally {
    try { await chrome.debugger.detach({ tabId }); } catch (_err) { /* already detached */ }
  }
}

async function executeViaTrustedInput(tabId, action, point) {
  return withDebugger(tabId, async () => {
    const send = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
    if (action.action === "HOVER") {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      return { message: `Trusted HOVER` };
    }
    // CLICK and TYPE (TYPE = click to focus at the point, then insert text
    // at the caret — a single click, so nothing gets selected/replaced).
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    if (action.action === "TYPE") {
      await new Promise((r) => setTimeout(r, 200));
      await send("Input.insertText", { text: action.text || "" });
    }
    return { message: `Trusted ${action.action}` };
  });
}

async function getElementRects(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_ELEMENT_RECTS" }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          message: `Page action bridge unavailable: ${chrome.runtime.lastError.message}`,
          elements: [],
          viewportWidth: 0,
          viewportHeight: 0,
        });
        return;
      }
      resolve(res?.success
        ? res
        : {
            success: false,
            message: res?.message || "Page action bridge returned no element manifest.",
            elements: [],
            viewportWidth: 0,
            viewportHeight: 0,
          });
    });
  });
}

async function verifyCompletion(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "VERIFY_COMPLETION" }, (res) => {
      // If we can't reach the content script for some reason, fail open
      // (trust the model) rather than looping forever.
      resolve(res?.success ? res : { isGoogleForm: false, confirmed: true, hasUnfilledRequired: false });
    });
  });
}

async function waitForPageLoad(tabId) {
  await new Promise(resolve => {
    const interval = setInterval(async () => {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") { clearInterval(interval); resolve(); }
    }, 200);
  });
  await new Promise(r => setTimeout(r, 2000));
}

async function setPanelCaptureVisibility(tabId, hidden) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "PAROKSH_SET_CAPTURE_VISIBILITY", hidden },
      (response) => {
        // A page without the content script is still capturable; do not make
        // panel hiding a prerequisite for the task.
        void chrome.runtime.lastError;
        resolve(response?.success === true);
      },
    );
  });
}

async function captureRawScreenshot(windowId, tabId) {
  const started = performance.now();
  await setPanelCaptureVisibility(tabId, true);
  // Let the compositor apply visibility:hidden before captureVisibleTab runs.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    return await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve({ dataUrl, durationMs: performance.now() - started });
      });
    });
  } finally {
    await setPanelCaptureVisibility(tabId, false);
  }
}

// ---------------------------------------------------------------------------
// PrivacyShield Offscreen Document Manager
//
// In MV3, DOM Canvas and WebAssembly workers run inside an offscreen document
// so that model inference, OCR, and blackout painting happen reliably
// in the extension's background environment without depending on target pages.
// ---------------------------------------------------------------------------

let creatingOffscreenPromise = null;

async function setupOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("privacy-shield/offscreen.html");

  if (chrome.offscreen?.hasDocument) {
    try {
      const hasDoc = await chrome.offscreen.hasDocument();
      if (hasDoc) return;
    } catch (_e) {}
  } else if (chrome.runtime?.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
      });
      if (contexts && contexts.length > 0) return;
    } catch (_e) {}
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen
    .createDocument({
      url: offscreenUrl,
      reasons: ["BLOBS", "DOM_PARSER", "LOCAL_STORAGE", "WORKERS"],
      justification: "Client-side on-device ONNX PII detection and redaction",
    })
    .catch((err) => {
      if (err?.message && (err.message.includes("Only a single offscreen document") || err.message.includes("already exists"))) {
        return;
      }
      console.error("PAROKSH: Failed to create offscreen document:", err);
      throw err;
    })
    .finally(() => {
      creatingOffscreenPromise = null;
    });

  await creatingOffscreenPromise;
}

async function ensurePrivacyShieldReady(tabId, step) {
  await setupOffscreenDocument();

  // Wait for the actual ONNX/OCR pipeline, not merely the offscreen document.
  // The document can exist while its 238 MB model is still loading.
  for (let attempt = 1; attempt <= 150; attempt++) {
    const isReady = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ target: "offscreen", type: "PRIVACY_SHIELD_PING" }, (res) => {
          if (chrome.runtime.lastError) {
            resolve(false);
          } else if (res?.state === "error") {
            resolve({ error: res.error || "PrivacyShield initialization failed." });
          } else {
            resolve(Boolean(res?.ready));
          }
        });
      } catch (_e) {
        resolve(false);
      }
    });

    if (isReady?.error) throw new Error(isReady.error);
    if (isReady === true) return true;
    if (attempt % 10 === 0 && tabId != null) {
        broadcastStatus(tabId, "privacy", `Step ${step}: initializing PrivacyShield on-device ML engine…`, { step });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("PrivacyShield is still initializing after 30 seconds. Check the extension service worker and offscreen document consoles.");
}

async function redactScreenshotWithPrivacyShield(dataUrl, tabId, step, rectData) {
  await ensurePrivacyShieldReady(tabId, step);

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        target: "offscreen",
        type: "PRIVACY_SHIELD_REDACT",
        dataUrl,
        viewportWidth: rectData?.viewportWidth,
        viewportHeight: rectData?.viewportHeight,
        elements: rectData?.elements || [],
        sensitiveRects: rectData?.sensitiveRects || [],
        runId: currentTask?.runId || null,
        step,
      },
      (res) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(`PrivacyShield communication error: ${chrome.runtime.lastError.message}`));
        }
        if (!res || !res.success) {
          return reject(new Error(`PrivacyShield redaction error: ${res?.error || "Unknown error"}`));
        }
        resolve(res);
      }
    );
  });
}

async function annotateScreenshot(dataUrl, rectData) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(
    1,
    MAX_SCREENSHOT_DIMENSION / Math.max(bitmap.width, bitmap.height)
  );
  const canvas = new OffscreenCanvas(
    Math.round(bitmap.width * scale),
    Math.round(bitmap.height * scale)
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create screenshot canvas.");

  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  drawMarks(ctx, rectData, canvas.width, canvas.height);

  const jpegBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: JPEG_QUALITY,
  });
  const bytes = new Uint8Array(await jpegBlob.arrayBuffer());

  return {
    base64: bytesToBase64(bytes),
  };
}

function bytesToBase64(bytes) {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

function drawMarks(ctx, rectData, canvasWidth, canvasHeight) {
  const { elements, viewportWidth, viewportHeight } = rectData;
  if (!elements?.length) return;
  const scaleX = canvasWidth / viewportWidth, scaleY = canvasHeight / viewportHeight;
  ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = 2; ctx.font = "bold 11px Arial";
  elements.forEach(el => {
    const x = el.x * scaleX, y = el.y * scaleY;
    ctx.strokeRect(x, y, el.width * scaleX, el.height * scaleY);
    ctx.fillStyle = "#ff3b30"; ctx.fillRect(x, y - 13, 15, 13);
    ctx.fillStyle = "#fff"; ctx.fillText(el.id, x + 3, y - 4);
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function executeNavigate(tabId, action) {
  await chrome.tabs.update(tabId, { url: action.url });
  return { message: `Navigated to ${action.url}` };
}

async function executeViaContentScript(tabId, action) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "EXECUTE_ACTION", action }, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      // Previously this discarded res.message and always rejected with a
      // generic "Failed" here, which meant the TRUSTED_INPUT_REQUIRED
      // signal from action-executor.js could never actually reach the
      // catch block below that's supposed to act on it.
      if (!res?.success) {
        reject(new Error(res?.message || "Failed"));
        return;
      }
      resolve({ message: res.message });
    });
  });
}
