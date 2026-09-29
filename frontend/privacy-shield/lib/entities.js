// Entity post-processing: the BIO merge over word-level predictions and the regex
// pass for sensitive strings. Ports `predict_ner()` and `detect_sensitive_patterns()`
// from the Python backend, including the word aggregation rule the README calls out:
// the first non-`O` piece of a word decides the word's label.

import { unionBox } from "./util.js";

// `\d` matches every Unicode decimal digit in Python, so `\p{Nd}` is used instead of
// JavaScript's ASCII-only `\d` and Devanagari digits (१२३) stay matchable.
//
// The order matters: several of these match the same digits, and the more specific
// identifier is listed first so it wins the tie (see `resolveSpans` in `sensitive.js`).
// A date is only a date if its parts are real: day 01-31, month 01-12. A regex cannot
// range-check those, so this subclass adds the check after the shape matches. Without it
// the pattern also accepts every SSN — `23-45-6789` reads as day 23, month 45 — and the
// sample page's SSN came back labelled DOB.
class DatePattern extends RegExp {
  test(text) {
    if (!super.test(text)) {
      return false;
    }
    const raw = text.split(/[/.-]/);
    const parts = raw.map(Number);
    // In `yyyy/mm/dd` the year leads, so the day is last; otherwise the day is first.
    const [day, month] = raw[0].length === 4 ? [parts[2], parts[1]] : [parts[0], parts[1]];
    return day >= 1 && day <= 31 && month >= 1 && month <= 12;
  }
}

export const SENSITIVE_PATTERNS = {
  SSN: /^\p{Nd}{3}[- ]\p{Nd}{2}[- ]\p{Nd}{4}$/u,
  AADHAAR: /^(?:\p{Nd}{4}[\s-]\p{Nd}{4}[\s-]\p{Nd}{4}|\p{Nd}{12})$/u,
  PAN: /^[A-Z]{5}\p{Nd}{4}[A-Z]$/iu,
  IFSC: /^[A-Z]{4}0[A-Z0-9]{6}$/u,
  // Four groups is a card; four groups of four with separators is indistinguishable from
  // a bank account, and both are sensitive, so neither needs a Luhn check here.
  CREDIT_CARD: /^(?:\p{Nd}{4}[\s-]?){3}\p{Nd}{2,7}$/u,
  DOB: new DatePattern(/^(?:\p{Nd}{1,2}[/.-]\p{Nd}{1,2}[/.-]\p{Nd}{2,4}|\p{Nd}{4}[/.-]\p{Nd}{1,2}[/.-]\p{Nd}{1,2})$/u),
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/u,
  PHONE: /^\+?(?:\p{Nd}[\s().-]?){10,15}$/u,
};

function compact(value) {
  return String(value).normalize("NFKC").replace(/[^\p{L}\p{Nd}]/gu, "");
}

function normalizePanCandidate(value) {
  const compacted = compact(value).toUpperCase();
  if (compacted.length !== 10) return compacted;
  // Tesseract commonly confuses these glyphs in the five-letter prefix and
  // final letter. Keep the four middle characters numeric.
  const letters = compacted.slice(0, 5).replace(/[01528]/g, (character) => ({
    "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B",
  }[character]));
  const suffix = compacted.slice(9).replace(/[01528]/g, (character) => ({
    "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B",
  }[character]));
  return letters + compacted.slice(5, 9) + suffix;
}

function matchesPattern(label, pattern, candidate) {
  if (pattern.test(candidate)) return true;
  const normalized = compact(candidate);
  if (label === "PAN") {
    if (/^[A-Z]{5}\p{Nd}{4}[A-Z]$/iu.test(normalized)) return true;
    const ocrNormalized = normalizePanCandidate(candidate);
    return /^[A-Z]{5}\p{Nd}{4}[A-Z]$/u.test(ocrNormalized)
      || /[A-Z]{5}\p{Nd}{4}[A-Z]/iu.test(normalized);
  }
  if (label === "PHONE") {
    const phone = String(candidate).normalize("NFKC").replace(/[\s().-]/gu, "");
    return /^\+?\p{Nd}{10,15}$/u.test(phone);
  }
  if (label === "AADHAAR") return /^\p{Nd}{12}$/u.test(normalized);
  if (label === "CREDIT_CARD") {
    const card = String(candidate).normalize("NFKC").replace(/[\s-]/gu, "");
    return /^\p{Nd}{14,19}$/u.test(card);
  }
  return false;
}

// The longest span of OCR words a pattern is allowed to span.
const MAX_SPAN_WORDS = 5;

// Merges word-level `{ label, confidence }` predictions into entity objects with a
// single union bounding box.
export function mergeBioEntities(words, predictions) {
  if (words.length !== predictions.length) {
    throw new Error(
      `expected one prediction per word, got ${predictions.length} predictions for ${words.length} words`,
    );
  }

  const entities = [];
  let current = null;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const { label, confidence } = predictions[index];
    if (label === "O") {
      if (current) {
        entities.push(current);
        current = null;
      }
      continue;
    }
    // `label.split("-", 1)[-1]`: everything after the first hyphen.
    const hyphen = label.indexOf("-");
    const entityType = hyphen === -1 ? label : label.slice(hyphen + 1);
    if (current && label.startsWith("I-") && current.label === entityType) {
      current.text += ` ${word.text}`;
      current.boxes.push(word);
      current.confidence = Math.min(current.confidence, confidence);
      current.end = index;
    } else {
      if (current) {
        entities.push(current);
      }
      current = {
        text: word.text,
        label: entityType,
        source: "ner",
        confidence,
        boxes: [word],
        // Word indexes, inclusive: `sensitive.js` rewrites the page over them.
        start: index,
        end: index,
      };
    }
  }
  if (current) {
    entities.push(current);
  }
  for (const entity of entities) {
    entity.boxes = [unionBox(entity.boxes)];
  }
  return entities;
}

// Repeated full matches of the sensitive patterns across spans of one to five OCR
// words, each reported with its union bounding box.
export function detectSensitivePatterns(words) {
  const patterns = Object.entries(SENSITIVE_PATTERNS);
  const entities = [];
  for (let start = 0; start < words.length; start += 1) {
    const limit = Math.min(start + MAX_SPAN_WORDS, words.length);
    for (let stop = start + 1; stop <= limit; stop += 1) {
      const span = words.slice(start, stop);
      const candidate = span.map((word) => word.text).join(" ");
      for (const [label, pattern] of patterns) {
        if (!matchesPattern(label, pattern, candidate)) {
          continue;
        }
        entities.push({
          text: candidate,
          label,
          source: "pattern",
          confidence: 1,
          boxes: [unionBox(span)],
          start,
          end: stop - 1,
        });
      }
    }
  }
  return entities;
}
