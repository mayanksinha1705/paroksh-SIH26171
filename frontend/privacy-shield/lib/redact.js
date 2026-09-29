// Blackout of selected regions: the client sends back the boxes it drew on the page it
// had recognized, and receives a PNG with those rectangles covered.
//
// The coordinates are normalized image pixels — the very space `/api/analyze` reports
// words and entities in — and the upload is normalized with the same `normalizeImage()`
// the OCR step used. EXIF rotation, transparency and colour space therefore cannot move
// a rectangle by a pixel, and no coordinate conversion happens anywhere.
//
// Rectangles are painted solid black: this is a redaction, so what is underneath is
// meant to be gone rather than dimmed. Nothing here returns an image that only looks
// blacked out — when no box survives clipping the caller gets an error instead.

import { normalizeImage } from "./image.js";

// A page holds at most a few hundred mentions; the cap only stops a runaway request.
export const MAX_BLACKOUT_BOXES = 2000;

const BLACK = { r: 0, g: 0, b: 0 };

export function blackoutError(message) {
  return new Error(message);
}

function toFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Reads the `boxes` multipart field: a JSON array of `{left, top, width, height}`.
export function parseBlackoutBoxes(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw blackoutError(
      "The 'boxes' field is required: a JSON array of {left, top, width, height}.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw blackoutError("The 'boxes' field must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw blackoutError("The 'boxes' field must be a JSON array.");
  }
  if (parsed.length === 0) {
    throw blackoutError("The 'boxes' field is empty, so there is nothing to black out.");
  }
  if (parsed.length > MAX_BLACKOUT_BOXES) {
    throw blackoutError(`Too many boxes: ${parsed.length} (the limit is ${MAX_BLACKOUT_BOXES}).`);
  }
  for (const box of parsed) {
    if (box === null || typeof box !== "object") {
      throw blackoutError("Every box must be an object with left, top, width and height.");
    }
    for (const field of ["left", "top", "width", "height"]) {
      if (toFinite(box[field]) === null) {
        throw blackoutError(`Every box needs a numeric ${field}.`);
      }
    }
  }
  return parsed;
}

// Clips boxes to the page and rounds them to whole pixels, dropping the ones that end up
// empty. Coordinates past an edge are pulled back to it instead of rejected, so a box
// drawn half outside the page still redacts the half that is on it.
export function clampBlackoutBoxes(boxes, width, height) {
  const rects = [];
  for (const box of boxes) {
    const left = toFinite(box?.left);
    const top = toFinite(box?.top);
    const boxWidth = toFinite(box?.width);
    const boxHeight = toFinite(box?.height);
    if (left === null || top === null || boxWidth === null || boxHeight === null) {
      continue;
    }
    const clipped = {
      left: Math.max(0, Math.min(width, Math.round(left))),
      top: Math.max(0, Math.min(height, Math.round(top))),
      right: Math.max(0, Math.min(width, Math.round(left + boxWidth))),
      bottom: Math.max(0, Math.min(height, Math.round(top + boxHeight))),
    };
    if (clipped.right - clipped.left <= 0 || clipped.bottom - clipped.top <= 0) {
      continue;
    }
    rects.push({
      left: clipped.left,
      top: clipped.top,
      width: clipped.right - clipped.left,
      height: clipped.bottom - clipped.top,
    });
  }
  return rects;
}

// The page as a PNG with every box covered. `count` is how many rectangles were actually
// painted, which is what the caller reports back to the user. `source` is anything
// `normalizeImage()` accepts (a File/Blob from the input or drop zone).
export async function redactImage(source, boxes) {
  const page = await normalizeImage(source);
  const rects = clampBlackoutBoxes(boxes, page.width, page.height);
  if (rects.length === 0) {
    throw blackoutError("None of the boxes fall inside the image, so nothing was blacked out.");
  }
  // `page.canvas` already holds the normalized (EXIF-rotated, alpha-flattened) pixels
  // from normalizeImage(), so painting straight onto it reuses the same canvas rather
  // than decoding the page twice.
  const context = page.canvas.getContext("2d");
  context.fillStyle = `rgb(${BLACK.r}, ${BLACK.g}, ${BLACK.b})`;
  for (const rect of rects) {
    context.fillRect(rect.left, rect.top, rect.width, rect.height);
  }
  const png = await new Promise((resolve, reject) => {
    page.canvas.toBlob(
      (result) => (result ? resolve(result) : reject(blackoutError("The browser could not encode the image."))),
      "image/png",
    );
  });
  return { png, width: page.width, height: page.height, count: rects.length };
}
