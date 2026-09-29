// Small numeric helpers shared by the OCR and NER pipeline. They stand in for the
// handful of numpy calls the Python reference implementation used.

// Stand-in for Python's `round(value, digits)`.
export function round(value, digits) {
  return Number(Number(value).toFixed(digits));
}

// Union of the bounding boxes of the OCR words an entity was built from.
// Replaces `union_box()` from the Python backend.
export function unionBox(words) {
  if (words.length === 0) {
    throw new Error("unionBox() needs at least one word");
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const word of words) {
    left = Math.min(left, word.left);
    top = Math.min(top, word.top);
    right = Math.max(right, word.left + word.width);
    bottom = Math.max(bottom, word.top + word.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

// Index of the largest value in `values[offset ... offset + length)`, first index
// winning ties exactly like `numpy.argmax`.
export function argmax(values, offset = 0, length = values.length - offset) {
  let best = 0;
  for (let index = 1; index < length; index += 1) {
    if (values[offset + index] > values[offset + best]) {
      best = index;
    }
  }
  return best;
}
