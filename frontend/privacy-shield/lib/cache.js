// IndexedDB cache for the large static assets (model.onnx, vocab.txt, config.json) so
// the ~230 MB the pipeline needs is only ever downloaded once per browser, not once per
// visit. There is no backend to cache these behind, so this is the whole strategy: fetch
// with a progress callback, stash the bytes in IndexedDB keyed by URL, and read from
// there on every later load. Tesseract's own language-data files (tessdata/*.traineddata)
// use tesseract.js's built-in IndexedDB cache instead (see lib/ocr.js) rather than this
// one, since that caching is already wired into the worker.

const DB_NAME = "pii-redactor-assets";
const STORE_NAME = "files";
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Streams the response so `onProgress({ loaded, total })` can drive a progress bar for a
// 227 MB download; `total` is null when the server does not send Content-Length.
async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${url} (HTTP ${response.status}).`);
  }
  const total = Number(response.headers.get("Content-Length")) || null;
  if (!response.body || !onProgress) {
    return response.arrayBuffer();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }
  const buffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

// Returns an ArrayBuffer, from IndexedDB when it's already there, otherwise fetched and
// then stored for next time. A quota or private-browsing failure to *write* the cache is
// swallowed — the fetch already succeeded, so the pipeline still works, just without the
// one-time-download benefit this run.
export async function cachedFetch(url, { onProgress } = {}) {
  const absoluteUrl = new URL(url, document.baseURI).href;
  let db;
  try {
    db = await openDatabase();
    const cached = await idbGet(db, absoluteUrl);
    if (cached) {
      onProgress?.({ loaded: cached.byteLength, total: cached.byteLength, cached: true });
      return cached;
    }
  } catch {
    db = null; // IndexedDB unavailable (e.g. private browsing) — fall through to a plain fetch.
  }
  const buffer = await fetchWithProgress(absoluteUrl, onProgress);
  if (db) {
    await idbSet(db, absoluteUrl, buffer).catch(() => {});
  }
  return buffer;
}

export async function cachedFetchText(url, options) {
  const buffer = await cachedFetch(url, options);
  return new TextDecoder("utf-8").decode(buffer);
}

export async function cachedFetchJson(url, options) {
  return JSON.parse(await cachedFetchText(url, options));
}

// Exposed for a "clear cache" control, in case a deployment ever swaps model.onnx and a
// returning visitor needs to drop the stale cached copy.
export async function clearAssetCache() {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
