// chromeBridge.js
//
// This is the ONLY file that talks to the rest of the extension. It preserves
// the exact same contract the original vanilla popup used:
//
//   chrome.runtime.sendMessage({ type: "EXECUTE_INSTRUCTION", instruction })
//   -> { success: boolean, message: string, reply: string }
//
// `message` is the raw, mechanical step log (still used for the activity
// log). `reply` is a natural, human-sounding chat message generated
// separately by ollama/ollama2.js, kept fully apart from the strict-JSON
// action model in ollama/ollama.js. React never reaches into the page DOM
// directly.

export function executeInstruction(instruction) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'EXECUTE_INSTRUCTION', instruction }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, message: 'Extension error: ' + chrome.runtime.lastError.message });
        return;
      }
      if (!response) {
        resolve({ success: false, message: 'No response from background worker.' });
        return;
      }
      resolve(response);
    });
  });
}

// Lets a freshly-mounted panel (recreated after a mid-task page navigation
// destroyed the previous one — see App.jsx) ask background.js whether a
// task is still running for this tab, and if so, get back its pipeline
// trace so far. If the task finished in the gap between the old panel
// dying and this one asking, background.js hands back that result once
// instead (see `finishedResult`).
export function getTaskStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_TASK_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ busy: false });
        return;
      }
      resolve(response || { busy: false });
    });
  });
}

// Live task-completion broadcast — sent in ADDITION to the normal
// executeInstruction() response, specifically so a panel that gets torn
// down and recreated mid-task (by a page navigation) still finds out how
// that task ended, even though its original executeInstruction() call was
// orphaned along with the rest of that panel's JS realm.
export function subscribeToTaskResult(onResult) {
  const tabId = getTabId();
  const listener = (message) => {
    if (message?.type !== 'PAROKSH_TASK_RESULT') return;
    if (tabId != null && message.tabId != null && message.tabId !== tabId) return;
    onResult(message);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function stopInstruction() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'STOP_INSTRUCTION' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ stopped: false });
        return;
      }
      resolve(response || { stopped: false });
    });
  });
}

// Live, per-stage pipeline status: background.js broadcasts one of these on
// every step of the agent loop (capturing the screenshot, running local
// Qwen3.5-0.8B, PrivacyShield redaction, sending to the backend/Gemma model,
// then executing the resulting action). Since every open panel — across
// every tab — receives every broadcast, filter to this panel's own tab so a
// task running in another tab doesn't show up here.
export function subscribeToPipelineStatus(onEvent) {
  const tabId = getTabId();
  const listener = (message) => {
    if (message?.type !== 'PAROKSH_PIPELINE_STATUS') return;
    if (tabId != null && message.tabId != null && message.tabId !== tabId) return;
    onEvent(message);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * background.js joins each step's result with " → " and appends a final
 * summary, e.g. "Clicked Submit → Typed into Name → Task completed: done".
 * Split that into individual steps (for the activity log) plus the final
 * summary line (for the chat reply).
 */
export function parseResultMessage(raw) {
  const parts = String(raw)
    .split('→')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { steps: [], summary: raw };
  return { steps: parts.slice(0, -1), summary: parts[parts.length - 1] };
}

// Asks the background worker to pull every sanitized ("after") screenshot
// out of the local privacy vault — the exact images that were sent to the
// LLM — and save them as real files under Downloads/paroksh_redacted.
export function exportRedactedImages() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'EXPORT_REDACTED_IMAGES' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, message: 'Extension error: ' + chrome.runtime.lastError.message });
        return;
      }

      resolve(response || { success: false, message: 'No response from background worker.' });
    });
  });
}

export function openAuditDashboard() {
  chrome.runtime.sendMessage({ type: 'OPEN_AUDIT_DASHBOARD' });
}

export function getTheme() {
  return new Promise((resolve) => {
    if (!chrome.storage?.local) return resolve('dark');
    chrome.storage.local.get(['paroksh_theme'], (res) => {
      resolve(res?.paroksh_theme === 'light' ? 'light' : 'dark');
    });
  });
}

export function setTheme(theme) {
  chrome.storage?.local?.set({ paroksh_theme: theme });
}

// ---------------------------------------------------------------------------
// Persisted chat state, per tab
//
// The floating panel is a real <iframe> injected by the content script, so a
// full page navigation destroys and recreates this whole React app — losing
// component state along with it. To make the conversation survive
// navigation (e.g. the agent's own NAVIGATE action, or the user clicking a
// link), the content script passes this tab's ID in as a ?tabId= query
// param, and we use it to persist/restore chat state in
// chrome.storage.session (cleared when the browser session ends, and when
// the tab itself closes — see background.js).
// ---------------------------------------------------------------------------

function getTabId() {
  const id = new URLSearchParams(window.location.search).get('tabId');
  return id ? Number(id) : null;
}

function chatStorageKey() {
  const tabId = getTabId();
  return tabId != null ? `paroksh_chat_${tabId}` : null;
}

export function loadChatState() {
  return new Promise((resolve) => {
    const key = chatStorageKey();
    if (!key || !chrome.storage?.session) return resolve(null);
    chrome.storage.session.get([key], (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res?.[key] || null);
    });
  });
}

export function saveChatState(state) {
  const key = chatStorageKey();
  if (!key || !chrome.storage?.session) return;
  chrome.storage.session.set({ [key]: state });
}

export function clearChatState() {
  const key = chatStorageKey();
  if (!key || !chrome.storage?.session) return;
  chrome.storage.session.remove([key]);
}
