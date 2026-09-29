// ONNX Runtime wrapper for the MuRIL token-classification model. Replaces
// `onnxruntime.InferenceSession` usage in the Python backend and CLI scripts: the
// session runs on CPU, and `predict_chunk()` / `predict_ner()` are ported one to one
// (per-word token spans, first-non-`O` piece wins, chunking at the 512 token limit).

import * as ort from "../vendor/onnxruntime-web/ort.wasm.min.mjs";
import { mergeBioEntities } from "./entities.js";
import { argmax, round } from "./util.js";

// Points onnxruntime-web at the vendored WASM runtime instead of jsDelivr, and pins it
// to one thread. Threaded WASM needs SharedArrayBuffer, which needs the page to be
// served with COOP/COEP response headers — not something a plain static host (GitHub
// Pages, S3, a `python -m http.server`...) sets by default. Single-threaded is slower
// but works unmodified on any static host.
ort.env.wasm.wasmPaths = new URL("../vendor/onnxruntime-web/", import.meta.url).href;
ort.env.wasm.numThreads = 1;

const MAX_SEQUENCE_LENGTH = 512;
const REQUIRED_INPUTS = ["input_ids", "attention_mask", "token_type_ids"];

// int64 input to ONNX Runtime, built from rows of token ids.
function int64Tensor(rows, dimensions) {
  const data = new BigInt64Array(dimensions[0] * dimensions[1]);
  let index = 0;
  for (const row of rows) {
    if (row.length !== dimensions[1]) {
      throw new Error(`expected every row to hold ${dimensions[1]} ids, got ${row.length}`);
    }
    for (const value of row) {
      data[index] = BigInt(value);
      index += 1;
    }
  }
  return new ort.Tensor("int64", data, dimensions);
}

// `np.exp(logits - logits.max(axis=-1, keepdims=True))` normalised per token.
function softmaxRows(logits, rows, columns) {
  const probabilities = new Float32Array(rows * columns);
  for (let row = 0; row < rows; row += 1) {
    const offset = row * columns;
    let maximum = -Infinity;
    for (let column = 0; column < columns; column += 1) {
      maximum = Math.max(maximum, logits[offset + column]);
    }
    let sum = 0;
    for (let column = 0; column < columns; column += 1) {
      const value = Math.exp(logits[offset + column] - maximum);
      probabilities[offset + column] = value;
      sum += value;
    }
    for (let column = 0; column < columns; column += 1) {
      probabilities[offset + column] /= sum;
    }
  }
  return probabilities;
}

export class NerPipeline {
  // `modelSource` is either a URL (string) the session fetches itself, or an
  // ArrayBuffer/Uint8Array already in hand (e.g. pulled out of the IndexedDB cache in
  // lib/cache.js, so the 227 MB model is only downloaded once). `config` is the parsed
  // contents of config.json, fetched the same two ways by the caller.
  static async create({ modelSource, config, tokenizer, onProgress }) {
    const id2label = config.id2label ?? {};
    const labelNames = Object.keys(id2label)
      .map(Number)
      .sort((first, second) => first - second)
      .map((id) => id2label[String(id)]);
    if (labelNames.length === 0) {
      throw new Error("config.json has no id2label map");
    }
    onProgress?.({ status: "loading model", progress: 0 });
    const session = await ort.InferenceSession.create(modelSource, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    onProgress?.({ status: "loading model", progress: 1 });
    const missing = REQUIRED_INPUTS.filter((name) => !session.inputNames.includes(name));
    if (missing.length > 0) {
      throw new Error(`model.onnx is missing the inputs ${missing.join(", ")}`);
    }
    return new NerPipeline({ session, labelNames, tokenizer });
  }

  constructor({ session, labelNames, tokenizer }) {
    this.session = session;
    this.labelNames = labelNames;
    this.tokenizer = tokenizer;
    this.outputName = session.outputNames[0];
  }

  // `session.run(None, feeds)`: raw logits plus per-token softmax probabilities.
  async tokenLogits(inputIds, attentionMask = null, tokenTypeIds = null) {
    const batchSize = inputIds.length;
    const seqLength = inputIds[0]?.length ?? 0;
    const attention = attentionMask ?? inputIds.map((row) => row.map(() => 1));
    const tokenTypes = tokenTypeIds ?? inputIds.map((row) => row.map(() => 0));
    const results = await this.session.run({
      input_ids: int64Tensor(inputIds, [batchSize, seqLength]),
      attention_mask: int64Tensor(attention, [batchSize, seqLength]),
      token_type_ids: int64Tensor(tokenTypes, [batchSize, seqLength]),
    });
    const output = results[this.outputName];
    const [rows, columns, labels] = output.dims;
    const logits = output.data;
    return {
      logits,
      probabilities: softmaxRows(logits, rows * columns, labels),
      batchSize: rows,
      seqLength: columns,
      numLabels: labels,
    };
  }

  // One chunk of OCR words. Every word is tokenized on its own and the pieces are
  // concatenated behind a single [CLS], so the model is asked for labels at the same
  // level of granularity it was fine-tuned at; the word's label is the first non-`O`
  // piece and its confidence the largest probability inside the word's token span.
  async predictChunk(chunk) {
    const inputIds = [this.tokenizer.clsTokenId];
    const ranges = [];
    for (const word of chunk) {
      const pieceIds = this.tokenizer.convertTokensToIds(this.tokenizer.tokenize(word.text));
      const start = inputIds.length;
      inputIds.push(...pieceIds);
      ranges.push([start, inputIds.length]);
    }
    inputIds.push(this.tokenizer.sepTokenId);

    const { logits, probabilities, numLabels } = await this.tokenLogits([inputIds]);
    const result = [];
    for (const [start, end] of ranges) {
      const labels = [];
      let confidence = 0;
      for (let token = start; token < end; token += 1) {
        labels.push(this.labelNames[argmax(logits, token * numLabels, numLabels)]);
        for (let column = 0; column < numLabels; column += 1) {
          confidence = Math.max(confidence, probabilities[token * numLabels + column]);
        }
      }
      const named = labels.filter((label) => label !== "O");
      // A word that tokenizes to nothing (whitespace only) cannot be labelled; the
      // Python version raised a ValueError here instead of silently reporting `O`.
      result.push({
        label: named.length > 0 ? named[0] : "O",
        confidence: round(confidence, 3),
      });
    }
    return result;
  }

  // Word level entities for a full OCR page: chunks of words stay under the 512 token
  // limit, then the BIO prefixes are merged into entities.
  async predictNer(words) {
    const predictions = [];
    let chunk = [];
    let tokenCount = 1;
    for (const word of words) {
      const pieceCount = this.tokenizer.tokenize(word.text).length || 1;
      if (chunk.length > 0 && tokenCount + pieceCount + 1 > MAX_SEQUENCE_LENGTH) {
        predictions.push(...(await this.predictChunk(chunk)));
        chunk = [];
        tokenCount = 1;
      }
      chunk.push(word);
      tokenCount += pieceCount;
    }
    if (chunk.length > 0) {
      predictions.push(...(await this.predictChunk(chunk)));
    }
    return mergeBioEntities(words, predictions);
  }
}
