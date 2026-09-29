import * as ort from "../vendor/onnxruntime-web/ort.wasm.min.mjs";
import { cachedFetch } from "./cache.js";

const MODEL_URL = new URL("../retinaface_r50.onnx", import.meta.url).href;
const INPUT_SIZE = 640;
const SCORE_THRESHOLD = 0.65;
const NMS_THRESHOLD = 0.4;
const FACE_BOX_EXPANSION_X = 0.35;
const FACE_BOX_EXPANSION_Y = 0.5;
const VARIANCE = [0.1, 0.2];
const MIN_SIZES = [[16, 32], [64, 128], [256, 512]];
const STEPS = [8, 16, 32];

let sessionPromise = null;
let faceModelLoadMs = null;

function anchors() {
  const output = [];
  for (let level = 0; level < STEPS.length; level += 1) {
    const featureSize = Math.ceil(INPUT_SIZE / STEPS[level]);
    for (let y = 0; y < featureSize; y += 1) {
      for (let x = 0; x < featureSize; x += 1) {
        for (const size of MIN_SIZES[level]) {
          output.push([(x + 0.5) * STEPS[level] / INPUT_SIZE, (y + 0.5) * STEPS[level] / INPUT_SIZE, size / INPUT_SIZE, size / INPUT_SIZE]);
        }
      }
    }
  }
  return output;
}

const PRIORS = anchors();

async function getSession(onProgress) {
  if (!sessionPromise) {
    const started = performance.now();
    sessionPromise = cachedFetch(MODEL_URL, {
      onProgress: (progress) => onProgress?.({ stage: "face-model", ...progress }),
    }).then((buffer) => ort.InferenceSession.create(new Uint8Array(buffer), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    })).then((session) => {
      faceModelLoadMs = performance.now() - started;
      return session;
    });
  }
  return sessionPromise;
}

function imageTensor(canvas) {
  const source = document.createElement("canvas");
  source.width = INPUT_SIZE;
  source.height = INPUT_SIZE;
  const context = source.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const rgba = context.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const data = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < plane; i += 1) {
    const offset = i * 4;
    data[i] = rgba[offset + 2] - 104;
    data[plane + i] = rgba[offset + 1] - 117;
    data[plane * 2 + i] = rgba[offset] - 123;
  }
  return new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

function flattenTensor(tensor) {
  return Array.from(tensor.data);
}

function decode(loc, conf, width, height) {
  const candidates = [];
  const count = Math.min(PRIORS.length, Math.floor(loc.length / 4));
  for (let i = 0; i < count; i += 1) {
    const score = conf[i * 2 + 1] ?? conf[i];
    if (score < SCORE_THRESHOLD) continue;
    const prior = PRIORS[i];
    const cx = prior[0] + loc[i * 4] * VARIANCE[0] * prior[2];
    const cy = prior[1] + loc[i * 4 + 1] * VARIANCE[0] * prior[3];
    const boxWidth = prior[2] * Math.exp(loc[i * 4 + 2] * VARIANCE[1]);
    const boxHeight = prior[3] * Math.exp(loc[i * 4 + 3] * VARIANCE[1]);
    candidates.push({
      score,
      left: Math.max(0, (cx - boxWidth / 2) * width),
      top: Math.max(0, (cy - boxHeight / 2) * height),
      width: Math.min(width, (cx + boxWidth / 2) * width) - Math.max(0, (cx - boxWidth / 2) * width),
      height: Math.min(height, (cy + boxHeight / 2) * height) - Math.max(0, (cy - boxHeight / 2) * height),
    });
  }
  return candidates.filter((box) => box.width > 2 && box.height > 2);
}

function expandFaceBox(box, width, height) {
  const horizontalPadding = box.width * FACE_BOX_EXPANSION_X;
  const verticalPadding = box.height * FACE_BOX_EXPANSION_Y;
  const left = Math.max(0, box.left - horizontalPadding);
  const top = Math.max(0, box.top - verticalPadding);
  const right = Math.min(width, box.left + box.width + horizontalPadding);
  const bottom = Math.min(height, box.top + box.height + verticalPadding);
  return {
    score: box.score,
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function iou(first, second) {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.left + first.width, second.left + second.width);
  const bottom = Math.min(first.top + first.height, second.top + second.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = first.width * first.height + second.width * second.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaxSuppression(boxes) {
  const remaining = [...boxes].sort((a, b) => b.score - a.score);
  const selected = [];
  while (remaining.length) {
    const current = remaining.shift();
    selected.push(current);
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (iou(current, remaining[i]) > NMS_THRESHOLD) remaining.splice(i, 1);
    }
  }
  return selected;
}

export async function detectFaces(canvas, onProgress) {
  const session = await getSession(onProgress);
  const inputName = session.inputNames[0];
  const result = await session.run({ [inputName]: imageTensor(canvas) });
  const loc = result.loc || result[session.outputNames[0]];
  const conf = result.conf || result[session.outputNames[1]];
  if (!loc || !conf) throw new Error("RetinaFace model did not return loc/conf outputs.");
  const boxes = nonMaxSuppression(
    decode(flattenTensor(loc), flattenTensor(conf), canvas.width, canvas.height),
  ).map((box) => expandFaceBox(box, canvas.width, canvas.height));
  console.log("[PAROKSH timing]", JSON.stringify({
    stage: "face",
    modelLoadMs: faceModelLoadMs,
    detected: boxes.length,
  }));
  return boxes;
}
