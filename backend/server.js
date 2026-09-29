// server.js
//
// PAROKSH backend.
//
// The Chrome extension can no longer import ollama.js / ollama2.js directly:
// a service worker may only import files inside the extension folder. So the
// model layer lives here instead, and the extension reaches it over HTTP.
//
// Two endpoints, matching the two model roles that already existed:
//   POST /api/action  -> ollama.js   (strict-JSON action model, the "hands")
//   POST /api/reply   -> ollama2.js  (human chat reply, the "voice")
//
// This process is the only thing that talks to Ollama. Screenshots arriving
// here have already been redacted in-page by PrivacyShield.

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getActionFromGemma, MODEL, OLLAMA_HOST } from "./ollama/ollama.js";
import { getHumanReply, CHAT_MODEL } from "./ollama/ollama2.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMP_DIR = path.join(__dirname, "temp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const PORT = Number(process.env.PORT) || 3000;

// Screenshots come in as base64, so the default 100kb JSON limit is far too
// small. Also allow the origin the extension calls from.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const app = express();
app.use(express.json({ limit: "100mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/**
 * The extension aborts its fetch when the user hits Stop. Express surfaces
 * that as the request closing early, so we mirror it into an AbortSignal and
 * hand it down to the Ollama call — otherwise a stopped run would keep a
 * generation alive on the server for no reason.
 */
function signalFromRequest(req) {
  const controller = new AbortController();
  req.on("close", () => {
    if (!req.complete) controller.abort();
  });
  return controller.signal;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    actionModel: MODEL,
    chatModel: CHAT_MODEL,
    ollamaHost: OLLAMA_HOST,
  });
});

app.post("/api/action", async (req, res) => {
  const { instruction, imageBase64, history = [], elements = [], safeText = "", metrics = {} } = req.body || {};

  if (typeof instruction !== "string" || !instruction.trim()) {
    return res.status(400).json({ error: "Missing 'instruction'." });
  }
  if (typeof imageBase64 !== "string" || !imageBase64) {
    return res.status(400).json({ error: "Missing 'imageBase64'." });
  }

  console.log(`[PAROKSH backend] Masked user input: ${instruction}`);

  // Store exactly the redacted image received from frontend into backend/temp/ folder
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `redacted_${timestamp}_${Math.random().toString(36).slice(2, 8)}.png`;
    const targetPath = path.join(TEMP_DIR, filename);
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    fs.writeFileSync(targetPath, Buffer.from(cleanBase64, "base64"));
    console.log(`[PAROKSH backend] Saved redacted image to temp: ${targetPath}`);
  } catch (fsErr) {
    console.warn("[PAROKSH backend] Failed to write image to temp folder:", fsErr.message);
  }

  try {
    const modelStarted = performance.now();
    const action = await getActionFromGemma(
      instruction,
      imageBase64,
      history,
      elements,
      safeText,
      signalFromRequest(req),
      { ...metrics, modelMs: performance.now() - modelStarted }
    );
    res.json({ action });
  } catch (err) {
    if (err.name === "AbortError") return; // client already went away
    console.error("PAROKSH backend: /api/action failed:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/reply", async (req, res) => {
  const { instruction, rawLog, success = true } = req.body || {};

  // getHumanReply never throws by design — it falls back to a plain string —
  // so this route always returns 200 with something the user can read.
  const reply = await getHumanReply(
    typeof instruction === "string" ? instruction : "",
    rawLog,
    Boolean(success)
  );
  res.json({ reply });
});

app.listen(PORT, () => {
  console.log(`PAROKSH backend listening on http://localhost:${PORT}`);
  console.log(`  action model: ${MODEL}`);
  console.log(`  chat model:   ${CHAT_MODEL}`);
  console.log(`  ollama host:  ${OLLAMA_HOST}`);
});
