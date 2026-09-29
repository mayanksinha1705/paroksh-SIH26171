// offscreen.js
//
// Runs the ONNX PII detection and redaction pipeline inside an offscreen document.
// This gives the pipeline full access to DOM Canvas, Web Workers, IndexedDB,
// and WebAssembly within the extension context without touching or depending on
// target web pages.

import { initPipeline, analyze, redact, detectFaceBoxes } from "./pipeline.js";

const BLACKOUT_PADDING = 4;
const IDENTIFIER_PADDING = {
  AADHAAR: 1,
};
const vault = [];
let pipelineState = "loading";
let pipelineError = null;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function updateStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
  console.log(`[PAROKSH PrivacyShield] ${text}`);
}

function memorySnapshot() {
  const memory = performance.memory;
  return memory ? {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  } : null;
}

// Pre-initialize pipeline in background as soon as offscreen document loads
const pipelineReady = initPipeline((progress) => {
  updateStatus(`Loading model/assets: ${progress.stage || "initializing"}...`);
})
  .then(() => {
    pipelineState = "ready";
    updateStatus("PrivacyShield ONNX engine loaded and ready.");
  })
  .catch((err) => {
    pipelineState = "error";
    pipelineError = err;
    console.warn("[PAROKSH PrivacyShield] Preload notice:", err.message);
    throw err;
  });

async function processRedaction(dataUrl, options = {}) {
  if (pipelineState === "error") {
    throw new Error(`PrivacyShield initialization failed: ${pipelineError?.message || "unknown error"}`);
  }
  await pipelineReady;
  const stageMetrics = {};
  updateStatus("Processing screenshot for sensitive PII redaction...");
  const ocrStarted = performance.now();
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const file = new File([blob], "screenshot.png", { type: "image/png" });

  const analysis = await analyze(file, (progress) => {
    chrome.runtime.sendMessage({
      type: "PAROKSH_PIPELINE_STATUS",
      stage: "privacy",
      label: `PrivacyShield: ${progress.stage || "scanning"}...`,
      progress,
    }).catch(() => {});
  });
  stageMetrics.ocrMs = analysis.metrics?.ocrMs ?? (performance.now() - ocrStarted);
  stageMetrics.nerMs = analysis.metrics?.nerMs ?? 0;
  stageMetrics.modelLoad = analysis.metrics?.modelLoad ?? null;

  const entities = analysis.entities || [];
  console.log(
    `[PAROKSH PrivacyShield] Scan complete. Found ${entities.length} total entities (${analysis.blocked || 0} blocked, ${analysis.review || 0} review).`
  );

  const rects = [];
  const redactionTypes = {};
  const addRedactionType = (label) => {
    const normalized = String(label || "PII").toUpperCase();
    redactionTypes[normalized] = (redactionTypes[normalized] || 0) + 1;
  };
  for (const entity of entities) {
    if (entity.sensitivity?.level !== "block") continue;
    if (entity.boxes && entity.boxes.length > 0) {
      const padding = IDENTIFIER_PADDING[entity.label] ?? BLACKOUT_PADDING;
      for (const box of entity.boxes) {
        const rect = {
          left: box.left - padding,
          top: box.top - padding,
          width: box.width + padding * 2,
          height: box.height + padding * 2,
        };
        rects.push(rect);
        addRedactionType(entity.label);
      }
    }
  }

  const image = await createImageBitmap(blob);
  const faceStarted = performance.now();
  const faceRects = await detectFaceBoxes(
    image,
    (progress) => updateStatus(`RetinaFace: ${progress.stage || "detecting"}...`)
  );
  stageMetrics.faceMs = performance.now() - faceStarted;
  for (const rect of faceRects) {
    rects.push(rect);
    addRedactionType("FACE");
  }
  const viewportWidth = Number(options.viewportWidth);
  const viewportHeight = Number(options.viewportHeight);
  if (viewportWidth > 0 && viewportHeight > 0 && image.width > 0 && image.height > 0) {
    const scaleX = image.width / viewportWidth;
    const scaleY = image.height / viewportHeight;
    for (const element of options.elements || []) {
      const label = String(element.label || "").toUpperCase();
      if (!["[PASSWORD]", "[EMAIL]", "[PHONE]", "[CARD]", "[ADDRESS]", "[PAN]"].includes(label)) continue;
      const rect = {
        left: element.x * scaleX,
        top: element.y * scaleY,
        width: element.width * scaleX,
        height: element.height * scaleY,
      };
      rects.push(rect);
      addRedactionType(label.slice(1, -1));
    }
    for (const sensitive of options.sensitiveRects || []) {
      const rect = {
        left: Number(sensitive.x) * scaleX,
        top: Number(sensitive.y) * scaleY,
        width: Number(sensitive.width) * scaleX,
        height: Number(sensitive.height) * scaleY,
      };
      if (rect.width <= 0 || rect.height <= 0) continue;
      rects.push(rect);
      addRedactionType(sensitive.label);
    }
  }
  image.close();

  let finalDataUrl = dataUrl;
  let redactedBoxesCount = 0;

  if (rects.length > 0) {
    const paintStarted = performance.now();
    updateStatus(`Applying solid black mask to ${rects.length} sensitive item(s)...`);
    const redactResult = await redact(file, rects);
    redactedBoxesCount = redactResult.count;
    finalDataUrl = await blobToDataUrl(redactResult.png);
    stageMetrics.paintMs = performance.now() - paintStarted;
    updateStatus(`Black mask applied to ${redactedBoxesCount} regions.`);
  } else {
    stageMetrics.paintMs = 0;
    updateStatus("No sensitive data detected on page.");
  }
  console.log("[PAROKSH timing]", JSON.stringify({
    stage: "privacy",
    ...stageMetrics,
    memory: memorySnapshot(),
  }));

  vault.push({
    timestamp: Date.now(),
    runId: options.runId || null,
    step: options.step || null,
    dataUrl: finalDataUrl,
    blockedCount: analysis.blocked || 0,
    reviewCount: analysis.review || 0,
    redactedCount: redactedBoxesCount,
    redactionTypes,
    metrics: { ...stageMetrics, memory: memorySnapshot() },
  });
  if (vault.length > 50) vault.shift();

  return {
    success: true,
    dataUrl: finalDataUrl,
    hasRedactions: rects.length > 0,
    redactedCount: redactedBoxesCount,
    blockedCount: analysis.blocked || 0,
    reviewCount: analysis.review || 0,
    entitiesCount: entities.length,
    faceDetectionAvailable: true,
    facesRedacted: faceRects.length,
    safeText: analysis.safe_text || "",
    metrics: { ...stageMetrics, memory: memorySnapshot() },
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target && message.target !== "offscreen") return false;

  if (message?.type === "PRIVACY_SHIELD_PING") {
    sendResponse({
      ok: pipelineState !== "error",
      ready: pipelineState === "ready",
      state: pipelineState,
      error: pipelineError?.message || null,
    });
    return false;
  }

  if (message?.type === "PRIVACY_SHIELD_REDACT") {
    processRedaction(message.dataUrl, message)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error("[PAROKSH PrivacyShield] Redaction error:", err);
        sendResponse({ success: false, error: err?.message || String(err) });
      });
    return true; // asynchronous response
  }

  if (message?.type === "PRIVACY_SHIELD_GET_VAULT") {
    sendResponse({ success: true, vault });
    return false;
  }
});

updateStatus("PrivacyShield offscreen script loaded.");
