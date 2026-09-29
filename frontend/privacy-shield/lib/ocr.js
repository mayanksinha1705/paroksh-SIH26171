// OCR through tesseract.js's WebAssembly build. Browser port of backend/lib/ocr.js: the
// command-line/`execFile` path made no sense once nothing runs on a server, so this
// keeps only the WASM engine the Node version already fell back to when no `tesseract`
// binary was installed — parsing, boxes and confidences are unchanged, so the rest of
// the pipeline (entities.js, sensitive.js) sees identical input either way.

import { round } from "./util.js";

export const OCR_LANGUAGES = "hin+eng";
// `OEM 1` (LSTM only) and `--psm 6` (one uniform block of text) mirror the backend.
const PAGE_SEGMENTATION_MODE = "6";

// Word rows of Tesseract's TSV: level 5, a non-empty text and a confidence of 0..100.
export function parseTsvWords(tsv) {
  const words = [];
  for (const line of tsv.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length < 12 || fields[0] === "level") {
      continue;
    }
    if (Number(fields[0]) !== 5) {
      continue;
    }
    const text = fields.slice(11).join("\t").trim();
    if (text.length === 0) {
      continue;
    }
    let confidence = Number(fields[10]);
    if (!Number.isFinite(confidence)) {
      confidence = 0;
    }
    if (confidence < 0) {
      continue;
    }
    words.push({
      text,
      confidence: round(confidence / 100, 3),
      left: Math.trunc(Number(fields[6])) || 0,
      top: Math.trunc(Number(fields[7])) || 0,
      width: Math.trunc(Number(fields[8])) || 0,
      height: Math.trunc(Number(fields[9])) || 0,
    });
  }
  return words;
}

let wasmWorkerPromise = null;

// One worker for the life of the page, exactly like the Node backend kept one for the
// life of the process: paying the model load once keeps the per-page cost to
// recognition alone. `assetPaths` points at the vendored tesseract.js files and the
// tessdata directory (see lib/cache.js for how those get to the browser).
async function getWasmWorker(assetPaths, onProgress) {
  if (wasmWorkerPromise) {
    return wasmWorkerPromise;
  }
  wasmWorkerPromise = (async () => {
    const module = await import(assetPaths.tesseractEsmUrl);
    const createWorker = module.createWorker ?? module.default?.createWorker;
    if (typeof createWorker !== "function") {
      throw new Error("tesseract.js did not export `createWorker`.");
    }
    const worker = await createWorker(OCR_LANGUAGES, 1, {
      workerPath: assetPaths.workerUrl,
      corePath: assetPaths.coreDirUrl,
      langPath: assetPaths.langDirUrl,
      // Blob workers cannot reliably import a chrome-extension:// script from
      // their opaque origin. Start the vendored worker directly instead.
      workerBlobURL: false,
      gzip: false,
      // "write": fetch once, then serve the eng/hin traineddata out of tesseract.js's
      // own IndexedDB cache (idb-keyval) on every later page load — the same one-time-
      // download idea as lib/cache.js, just using the caching tesseract.js already ships.
      cacheMethod: "write",
      logger: onProgress,
    });
    await worker.setParameters({ tessedit_pageseg_mode: PAGE_SEGMENTATION_MODE });
    return worker;
  })();
  return wasmWorkerPromise;
}

// `png` is a Blob/File (or anything tesseract.js's `recognize()` accepts). Returns the
// same word-level shape the backend's TSV parsing produced.
export async function extractOcrWords(png, assetPaths, onProgress) {
  try {
    const worker = await getWasmWorker(assetPaths, onProgress);
    const { data } = await worker.recognize(png, {}, { tsv: true });
    return parseTsvWords(data.tsv ?? "");
  } catch (error) {
    throw new Error(`OCR failed: ${`${error.message ?? error}`.slice(0, 300)}`);
  }
}
