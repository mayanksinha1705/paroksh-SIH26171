// ---------------------------------------------------------------------------
// Floating, draggable in-page panel
//
// The React popup (frontend/popup.html) is loaded inside an <iframe> that we
// inject into the host page as a fixed-position card. Dragging is handled
// ENTIRELY on the host page via a thin invisible strip laid on top of the
// iframe's title area — never inside the iframe. This matters: mouse
// coordinates inside an iframe are relative to the iframe's own viewport,
// not the host page's, so computing a drag offset from an iframe-side
// mousedown and then applying it to host-side mousemove events (two
// different coordinate spaces) is what caused the earlier jumpy/stuck
// dragging. Keeping mousedown/mousemove/mouseup all on the host document
// avoids that mismatch entirely and gives smooth, unrestricted movement.
// ---------------------------------------------------------------------------

const PANEL_ID = "paroksh-float-panel";
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 420;
const DRAG_STRIP_WIDTH = 230; // covers the title area, leaves the header's buttons clickable
const DRAG_STRIP_HEIGHT = 36;

const panelState = {
  container: null,
  iframe: null,
  dragStrip: null,
  dragging: false,
  offsetX: 0,
  offsetY: 0,
};

// This tab's own ID, learned from background (content scripts can't read
// their own tab ID directly). Passed into the iframe as a query param so
// the React app can key its persisted chat state per tab in
// chrome.storage.session — that's what lets the conversation survive a full
// page navigation instead of resetting along with the rest of the DOM.
let currentTabId = null;

function createPanel() {
  if (panelState.container) return;

  const container = document.createElement("div");
  container.id = PANEL_ID;
  Object.assign(container.style, {
    position: "fixed",
    top: "72px",
    right: "24px",
    left: "auto",
    width: PANEL_WIDTH + "px",
    height: PANEL_HEIGHT + "px",
    zIndex: "2147483647",
    borderRadius: "14px",
    overflow: "hidden",
    boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
    background: "#0a0a0b",
  });

  const iframe = document.createElement("iframe");
  iframe.id = "paroksh-float-iframe";
  iframe.src = chrome.runtime.getURL("frontend/popup.html") +
    (currentTabId != null ? `?tabId=${currentTabId}` : "");
  iframe.title = "PAROKSH — AI Browser Agent";
  // Without this, the browser's permissions-policy blocks getUserMedia
  // (and therefore the Web Speech API) inside the iframe outright, before
  // any mic prompt can even appear — surfaces as a silent "not-allowed"
  // SpeechRecognition error with no dialog ever shown.
  iframe.setAttribute("allow", "microphone");
  Object.assign(iframe.style, {
    width: "100%",
    height: "100%",
    border: "none",
    display: "block",
    background: "transparent",
  });

  // Invisible drag handle sitting on top of the iframe's title area. It
  // never intercepts clicks on the header's buttons (New session, Settings,
  // Close) because it's sized/positioned to only cover the title text.
  const dragStrip = document.createElement("div");
  Object.assign(dragStrip.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: DRAG_STRIP_WIDTH + "px",
    height: DRAG_STRIP_HEIGHT + "px",
    cursor: "grab",
    background: "transparent",
    zIndex: "2",
  });

  container.appendChild(iframe);
  container.appendChild(dragStrip);
  document.documentElement.appendChild(container);

  dragStrip.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // left click only
    e.preventDefault();
    beginDrag(e.clientX, e.clientY);
  });

  panelState.container = container;
  panelState.iframe = iframe;
  panelState.dragStrip = dragStrip;
}

function removePanel() {
  if (!panelState.container) return;
  panelState.container.remove();
  panelState.container = null;
  panelState.iframe = null;
  panelState.dragStrip = null;
  endDrag();
}

function beginDrag(clientX, clientY) {
  if (!panelState.container) return;
  const rect = panelState.container.getBoundingClientRect();

  // Switch from right-anchored to left/top-anchored so it can move freely.
  panelState.container.style.left = rect.left + "px";
  panelState.container.style.top = rect.top + "px";
  panelState.container.style.right = "auto";

  panelState.dragging = true;
  panelState.offsetX = clientX - rect.left;
  panelState.offsetY = clientY - rect.top;

  // Prevent the iframe from swallowing mousemove/mouseup mid-drag.
  if (panelState.iframe) panelState.iframe.style.pointerEvents = "none";
  if (panelState.dragStrip) panelState.dragStrip.style.cursor = "grabbing";
  document.documentElement.style.userSelect = "none";

  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", endDrag);
}

function onDragMove(e) {
  if (!panelState.dragging || !panelState.container) return;
  const maxLeft = Math.max(0, window.innerWidth - PANEL_WIDTH);
  const maxTop = Math.max(0, window.innerHeight - PANEL_HEIGHT);
  const left = Math.min(Math.max(0, e.clientX - panelState.offsetX), maxLeft);
  const top = Math.min(Math.max(0, e.clientY - panelState.offsetY), maxTop);
  panelState.container.style.left = left + "px";
  panelState.container.style.top = top + "px";
}

function endDrag() {
  panelState.dragging = false;
  if (panelState.iframe) panelState.iframe.style.pointerEvents = "auto";
  if (panelState.dragStrip) panelState.dragStrip.style.cursor = "grab";
  document.documentElement.style.userSelect = "";
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", endDrag);
}

// Message posted from inside the React app (frontend/popup.html) via
// window.parent.postMessage — used only for the close (✕) button, which is
// a single click and has no coordinate-space concerns.
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "paroksh-panel") return;
  if (event.source !== panelState.iframe?.contentWindow) return;

  if (data.type === "close") {
    removePanel();
    // Tell background this was an explicit close, so the panel stays closed
    // on future navigations instead of auto-reopening.
    chrome.runtime.sendMessage({ type: "PANEL_CLOSED" });
  }

  if (data.type === "voice-mode") {
    setVoiceGuard(!!data.active);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "PAROKSH_SET_CAPTURE_VISIBILITY") return false;
  if (panelState.container) {
    panelState.container.style.visibility = message.hidden ? "hidden" : "";
  }
  sendResponse({ success: true });
  return false;
});

// ---------------------------------------------------------------------------
// Voice-mode focus guard
//
// Our orb mode sends everything you say to the agent — it never types into
// the page. But OS-level dictation (e.g. Windows' own Voice Typing) listens
// to the same microphone independently and types literally into whatever
// field on the page currently has keyboard focus, with no way for us to
// intercept or distinguish it from real typing. While orb mode is active,
// immediately blur any input/textarea/contenteditable that grabs focus so
// there's nowhere on the page for that stray dictation to land.
// ---------------------------------------------------------------------------

let voiceGuardActive = false;

function isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function onHostFocusIn(e) {
  if (isEditable(e.target)) {
    e.target.blur();
  }
}

function setVoiceGuard(active) {
  if (active === voiceGuardActive) return;
  voiceGuardActive = active;
  if (active) {
    document.addEventListener("focusin", onHostFocusIn, true);
    if (isEditable(document.activeElement)) document.activeElement.blur();
  } else {
    document.removeEventListener("focusin", onHostFocusIn, true);
  }
}

// A full page navigation tears down this whole script and re-runs a fresh
// copy on the new page — so on every load, ask background whether the panel
// should still be open for this tab and, if so, recreate it immediately.
chrome.runtime.sendMessage({ type: "GET_PANEL_STATE" }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res?.tabId != null) currentTabId = res.tabId;
  if (res?.open) createPanel();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;
  if (message.type === "OPEN_PANEL") {
    if (message.tabId != null) currentTabId = message.tabId;
    createPanel();
    sendResponse({ success: true });
    return false;
  }
  if (message.type === "CLOSE_PANEL") {
    removePanel();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "GET_ELEMENT_RECTS") {
    try {
      const data = window.AIAgentExecutor.getElementRects();
      sendResponse({ success: true, ...data });
    } catch (err) {
      sendResponse({ success: false, message: err.message });
    }
    return false;
  }
  if (message.type === "VERIFY_COMPLETION") {
    try {
      const data = window.AIAgentExecutor.verifyCompletion();
      sendResponse({ success: true, ...data });
    } catch (err) {
      sendResponse({ success: false, message: err.message });
    }
    return false;
  }
  if (message.type === "EXECUTE_ACTION") {
    (async () => {
      try {
        const res = await window.AIAgentExecutor.execute(message.action);
        sendResponse({ success: true, message: res });
      } catch (err) {
        sendResponse({ success: false, message: err.message });
      }
    })();
    return true;
  }
});
