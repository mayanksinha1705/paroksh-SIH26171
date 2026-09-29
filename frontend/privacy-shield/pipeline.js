// Runs the whole analysis in the browser: what used to be a POST to `/api/analyze` /
// `/api/redact` on the Express server is now these two functions. Same inputs, same
// output shapes (see backend/main.js) — `frontend/app.js` barely has to know the
// difference, beyond awaiting a local call instead of `fetch()`.

import { BertTokenizer } from "./lib/tokenizer.js";
import { NerPipeline } from "./lib/ner.js";
import { detectSensitivePatterns } from "./lib/entities.js";
import { detectLabeledFields, markSensitivity } from "./lib/sensitive.js";
import { extractOcrWords } from "./lib/ocr.js";
import { normalizeImage } from "./lib/image.js";
import { redactImage } from "./lib/redact.js";
import { detectFaces } from "./lib/face-detector.js";
import { cachedFetch, cachedFetchText, cachedFetchJson } from "./lib/cache.js";

// Resolved against this file's own location rather than the page URL, so the app still
// finds its assets when it's deployed under a sub-path (e.g. a GitHub Pages project
// site) instead of a domain root.
const ASSET_BASE = new URL(".", import.meta.url);
const VOCAB_URL = new URL("vocab.txt", ASSET_BASE).href;
const CONFIG_URL = new URL("config.json", ASSET_BASE).href;
const MODEL_URL = new URL("model.onnx", ASSET_BASE).href;
const TESSERACT_ASSET_PATHS = {
  tesseractEsmUrl: new URL("vendor/tesseract/tesseract.esm.min.js", ASSET_BASE).href,
  workerUrl: new URL("vendor/tesseract/worker.min.js", ASSET_BASE).href,
  coreDirUrl: new URL("vendor/tesseract-core/", ASSET_BASE).href,
  langDirUrl: new URL("tessdata/", ASSET_BASE).href,
};

let pipelineReady = null;
let modelLoadMetrics = null;

function memorySnapshot() {
  const memory = performance.memory;
  return memory ? {
    usedJSHeapSize: memory.usedJSHeapSize,
    totalJSHeapSize: memory.totalJSHeapSize,
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
  } : null;
}

// The tokenizer + ONNX session load once (the model alone is 227 MB, even cached in
// IndexedDB it still has to be parsed by onnxruntime-web every page load) and are reused
// for every image analyzed afterwards. `onProgress({ stage, loaded, total, cached })` is
// called throughout the first call so the UI can show a real progress bar for the
// one-time download; later calls resolve immediately from the already-loaded pipeline.
export function initPipeline(onProgress) {
  if (!pipelineReady) {
    pipelineReady = loadPipeline(onProgress).catch((error) => {
      pipelineReady = null; // let a retry after a failed load try again
      throw error;
    });
  }
  return pipelineReady;
}

async function loadPipeline(onProgress) {
  const started = performance.now();
  const vocabText = await cachedFetchText(VOCAB_URL, {
    onProgress: (progress) => onProgress?.({ stage: "vocab", ...progress }),
  });
  const tokenizer = BertTokenizer.fromVocabText(vocabText, { doLowerCase: false });

  const config = await cachedFetchJson(CONFIG_URL, {
    onProgress: (progress) => onProgress?.({ stage: "config", ...progress }),
  });

  const modelBuffer = await cachedFetch(MODEL_URL, {
    onProgress: (progress) => onProgress?.({ stage: "model", ...progress }),
  });
  const ner = await NerPipeline.create({
    modelSource: new Uint8Array(modelBuffer),
    config,
    tokenizer,
    onProgress: (progress) => onProgress?.({ stage: "model-init", ...progress }),
  });

  modelLoadMetrics = {
    durationMs: performance.now() - started,
    memory: memorySnapshot(),
  };
  return { tokenizer, ner };
}

// Same response shape `POST /api/analyze` used to return.
export async function analyze(file, onProgress) {
  if (!file.type || !file.type.startsWith("image/")) {
    throw new Error("Please upload an image file.");
  }
  const { ner } = await initPipeline(onProgress);

  const page = await normalizeImage(file);
  const ocrStarted = performance.now();
  const words = await extractOcrWords(page.png, TESSERACT_ASSET_PATHS, (progress) =>
    onProgress?.({ stage: "ocr", ...progress }),
  );
  const ocrMs = performance.now() - ocrStarted;

  // Names, addresses, phone numbers and identifiers are marked before anything leaves
  // this function: the same three detectors the server used to combine (NER model,
  // shape-based regexes, labelled-field rules), merged by the same precedence rules.
  const nerStarted = performance.now();
  const nerPredictions = words.length === 0 ? [] : await ner.predictNer(words);
  const nerMs = performance.now() - nerStarted;
  const marked = markSensitivity(
    words,
    words.length === 0
      ? []
      : [
          ...nerPredictions,
          ...detectSensitivePatterns(words),
          ...detectLabeledFields(words),
        ],
  );

  return {
    width: page.width,
    height: page.height,
    text: words.map((word) => word.text).join(" "),
    words,
    entities: marked.entities,
    safe_text: marked.safeText,
    blocked: marked.blocked,
    review: marked.review,
    metrics: {
      ocrMs,
      nerMs,
      modelLoad: modelLoadMetrics,
      memory: memorySnapshot(),
    },
  };
}

// Same result shape `POST /api/redact` used to return, minus the HTTP wrapping:
// `{ png, width, height, count }` with `png` as a Blob instead of a response body.
export async function redact(file, boxes) {
  return redactImage(file, boxes);
}

export async function detectFaceBoxes(canvas, onProgress) {
  return detectFaces(canvas, onProgress);
}
