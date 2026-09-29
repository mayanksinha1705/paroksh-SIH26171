// Which detected data may leave the machine, and in what form.
//
// The rule this tool enforces: a name, an address, a phone number, an identifier —
// anything that points at a person — must not be pasted into a vision-language model.
// This module turns the raw detections into (a) entities that each carry a sensitivity
// verdict and a plain-language reason, and (b) `safeText`: the page text with every
// blocked value replaced by a stable `[NAME_1]`-style placeholder. `safeText` is the
// only form of the page meant to be handed to a model; the image blackout is the other
// half of the same policy.
//
// Two detectors feed this. The patterns in `entities.js` catch values by shape. The
// field labels below catch them by context — `पता: दिल्ली, भारत` is an address only
// because a form field says so, and `SSN: 23-45-6789` is still one after OCR drops a
// digit and no pattern matches it any more.

import { SENSITIVE_PATTERNS } from "./entities.js";
import { unionBox } from "./util.js";

// `block` = never hand this to a model, `review` = show it to the user first. The
// placeholder is what the value turns into inside `safeText`.
export const SENSITIVITY = {
  PER: { level: "block", placeholder: "NAME", reason: "person name" },
  ADDRESS: { level: "block", placeholder: "ADDRESS", reason: "postal address" },
  PHONE: { level: "block", placeholder: "PHONE", reason: "phone number" },
  EMAIL: { level: "block", placeholder: "EMAIL", reason: "email address" },
  SSN: { level: "block", placeholder: "SSN", reason: "social security number" },
  AADHAAR: { level: "block", placeholder: "AADHAAR", reason: "Aadhaar number" },
  PAN: { level: "block", placeholder: "PAN", reason: "PAN tax identifier" },
  ACCOUNT: { level: "block", placeholder: "ACCOUNT", reason: "bank account number" },
  IFSC: { level: "block", placeholder: "IFSC", reason: "bank branch code" },
  CREDIT_CARD: { level: "block", placeholder: "CARD", reason: "card number" },
  PASSPORT: { level: "block", placeholder: "PASSPORT", reason: "passport number" },
  LICENSE: { level: "block", placeholder: "LICENSE", reason: "licence number" },
  DOB: { level: "block", placeholder: "DOB", reason: "date of birth" },
  ORG: { level: "review", placeholder: "ORG", reason: "organisation name" },
  LOC: { level: "review", placeholder: "PLACE", reason: "place name" },
  MISC: { level: "review", placeholder: "OTHER", reason: "unclassified text" },
};

const UNCLASSIFIED = { level: "review", placeholder: "OTHER", reason: "unclassified text" };

export function sensitivityOf(label) {
  return SENSITIVITY[label] ?? UNCLASSIFIED;
}

// Strongest first. When two detectors cover the same words the identifier wins over the
// coarser label: an Aadhaar number that also looks like a phone number stays Aadhaar.
const STRENGTH = [
  "SSN", "AADHAAR", "PAN", "ACCOUNT", "IFSC", "CREDIT_CARD", "PASSPORT", "LICENSE", "DOB",
  "EMAIL", "PHONE", "ADDRESS", "PER", "ORG", "LOC", "MISC",
];

export function strength(label) {
  const rank = STRENGTH.indexOf(label);
  return rank === -1 ? STRENGTH.length : rank;
}

// The field names a form uses for the data that must not travel. Hindi first, because
// that is what the sample page and most of the target documents are written in.
const FIELD_LABELS = {
  PER: ["नाम", "ग्राहक नाम", "धारक", "नामांकित", "name", "full name", "customer name", "applicant", "holder", "श्री", "श्रीमती", "father", "पिता", "माता", "mother", "mr", "mrs", "ms"],
  ADDRESS: ["पता", "पते", "निवास", "मोहल्ला", "जिला", "शहर", "गांव", "address", "addr", "residence", "district", "city", "village", "pin", "pincode", "zip", "postal", "डाक"],
  PHONE: ["फोन", "फ़ोन", "फोन नंबर", "मोबाइल", "मोबाइल नंबर", "संपर्क", "phone", "phone no", "phone number", "mobile", "contact", "tel", "telephone", "whatsapp", "cell"],
  EMAIL: ["ईमेल", "मेल", "email", "e-mail", "mail"],
  SSN: ["ssn", "सामाजिक सुरक्षा", "social security"],
  AADHAAR: ["आधार", "आधार संख्या", "aadhaar", "aadhar", "uidai"],
  PAN: ["पैन", "pan", "pan no"],
  ACCOUNT: ["खाता", "खाता संख्या", "account", "account no", "account number", "बैंक खाता", "a/c"],
  IFSC: ["ifsc", "आईएफएससी"],
  CREDIT_CARD: ["कार्ड", "card", "card no", "credit card", "debit card", "cvv", "atm"],
  PASSPORT: ["पासपोर्ट", "passport", "passport no"],
  LICENSE: ["ड्राइविंग", "licence", "license", "driving licence", "driving license"],
  DOB: ["जन्म", "जन्म तिथि", "जन्मतिथि", "dob", "d.o.b", "date of birth", "birth"],
};

// Labels are matched on the word with its separator trimmed, so the colon OCR glues onto
// the token — `नाम:`, `पता:` — never has to be guessed at.
const SEPARATORS = /[:：\-\u2013\u2014,;.।]+$/u;
const HAS_COLON = /[:：]/u;
const HAS_DIGIT = /\p{Nd}/u;
// Keys this short are too easy to hit in prose to accept without a colon: `ac`, `mr`, `ms`.
const MIN_KEY_WITHOUT_COLON = 3;
const MAX_LABEL_WORDS = 3;

export function normalizeToken(text) {
  return text.replace(SEPARATORS, "").trim();
}

// Field names are matched case-insensitively, so `SSN:` and `ssn` are the same key.
// Devanagari is unaffected by the lowering, which is why it can be used unconditionally.
function keyOf(text) {
  return normalizeToken(text).toLowerCase();
}

const LABEL_BY_KEY = new Map();
for (const [label, keys] of Object.entries(FIELD_LABELS)) {
  for (const key of keys) {
    LABEL_BY_KEY.set(keyOf(key), { label, key });
  }
}

// The field label ending at `index`, longest match first (`फोन नंबर:` beats `फोन:`).
export function matchFieldLabel(words, index) {
  const first = Math.max(0, index - (MAX_LABEL_WORDS - 1));
  for (let begin = index; begin >= first; begin -= 1) {
    const text = words.slice(begin, index + 1).map((word) => word.text).join(" ");
    const match = LABEL_BY_KEY.get(keyOf(text));
    if (!match) {
      continue;
    }
    if (!HAS_COLON.test(text) && match.key.length < MIN_KEY_WITHOUT_COLON) {
      continue;
    }
    return { ...match, start: begin, hasColon: HAS_COLON.test(text) };
  }
  return null;
}

// A colon-less label is only trusted when the next word is shaped like a value. That is
// what keeps the sentence `मुंबई शाखा में खाता खुला है` untouched: `खाता` is a label word,
// but `खुला` is prose.
export function looksLikeValue(text) {
  if (HAS_DIGIT.test(text)) {
    return true;
  }
  return Object.values(SENSITIVE_PATTERNS).some((pattern) => pattern.test(text));
}

function looksLikeIdentifierValue(text, label) {
  if (!looksLikeValue(text)) {
    return false;
  }
  if (label === "PAN") {
    // A PAN always contains four digits. Do not treat an ordinary word after
    // `PAN:` (for example, a state name) as the identifier when OCR missed
    // the actual value.
    return /\p{Nd}/u.test(text);
  }
  if (["AADHAAR", "SSN", "ACCOUNT", "IFSC", "CREDIT_CARD", "DOB", "PHONE"].includes(label)) {
    return /\p{Nd}/u.test(text);
  }
  return true;
}

// Function words end a value run, so `पता: दिल्ली, भारत में स्थित है` redacts the address
// and not the rest of the sentence.
const VALUE_STOPWORDS = new Set([
  "में", "का", "की", "के", "को", "से", "पर", "और", "तथा", "है", "हैं", "था", "थी", "हो", "ने",
  "यह", "वह", "इस", "उस", "स्थित", "लिए", "साथ", "अधीन", "is", "are", "was", "were", "the",
  "and", "of", "for", "at", "in", "on", "to", "with", "has", "have", "from", "by",
]);

export function isStopword(text) {
  return VALUE_STOPWORDS.has(keyOf(text));
}

// At most this many words are taken as one field's value.
const MAX_VALUE_WORDS = 6;
// A value that is one identifier — a number, an account, an email — is a run of
// digit-bearing words, not a run of words up to the next stopword. Without this,
// `SSN: 23-45-6789 मुंबई शाखा में खाता खुला है` would redact the sentence after the field
// as well: मुंबई and शाखा carry no digit, so the run stops at the value.
const IDENTIFIER_LABELS = new Set([
  "SSN", "AADHAAR", "PAN", "ACCOUNT", "IFSC", "CREDIT_CARD", "PASSPORT", "LICENSE",
  "DOB", "PHONE", "EMAIL",
]);
const MAX_IDENTIFIER_WORDS = 4;
// Sentence enders: a value never continues past one.
const ENDS_SENTENCE = /[।.!?]$/u;
const INLINE_COLON = /[:：]/u;

// Detections that come from a field label rather than from a pattern: the value of
// `नाम:` is a name because the form says so, whatever the shape of the value is. This is
// what catches data no pattern can, and it survives OCR damage — `SSN: 23-45-6789` is
// still an SSN after a digit is dropped and the pattern stops matching.
export function detectLabeledFields(words) {
  const detections = [];
  let nextFree = 0;
  for (let index = 0; index < words.length; index += 1) {
    if (index < nextFree) {
      continue;
    }
    const match = matchFieldLabel(words, index);
    if (!match || match.start < nextFree) {
      continue;
    }
    const remainder = inlineValue(words[index].text, match.hasColon);
    if (remainder && IDENTIFIER_LABELS.has(match.label)
      && !looksLikeIdentifierValue(remainder, match.label)) {
      continue;
    }
    const value = remainder ? [index] : collectValue(words, index + 1, match);
    if (value.length === 0) {
      continue;
    }
    detections.push({
      text: remainder || value.map((word) => words[word].text).join(" "),
      label: match.label,
      source: "label",
      confidence: match.hasColon ? 1 : 0.8,
      start: value[0],
      end: value[value.length - 1],
    });
    nextFree = value[value.length - 1] + 1;
  }
  return detections;
}

// The text after the colon when the label and its value share one OCR token.
function inlineValue(text, hasColon) {
  if (!hasColon) {
    return "";
  }
  const index = text.search(INLINE_COLON);
  return index === -1 ? "" : text.slice(index + 1).trim();
}

// The words that make up one field's value. Returns word indexes, not words.
function collectValue(words, begin, match) {
  const identifier = IDENTIFIER_LABELS.has(match.label);
  const limit = identifier ? MAX_IDENTIFIER_WORDS : MAX_VALUE_WORDS;
  const value = [];
  for (let index = begin; index < words.length; index += 1) {
    const text = words[index].text;
    if (normalizeToken(text) === "") {
      continue;
    }
    if (identifier && value.length > 0 && !HAS_DIGIT.test(text)) {
      break;
    }
    if (value.length > 0 && (isStopword(text) || INLINE_COLON.test(text) || matchFieldLabel(words, index))) {
      break;
    }
    // A colon-less label only claims a value that is shaped like one.
    if (value.length === 0 && !match.hasColon && !looksLikeIdentifierValue(text, match.label)) {
      return [];
    }
    if (value.length === 0 && match.hasColon && IDENTIFIER_LABELS.has(match.label)
      && !looksLikeIdentifierValue(text, match.label)) {
      return [];
    }
    value.push(index);
    if (ENDS_SENTENCE.test(text) || value.length === limit) {
      break;
    }
  }
  return value;
}

// What the user actually needs to know about one detection.
function verdictOf(entity) {
  const sensitivity = sensitivityOf(entity.label);
  return {
    level: sensitivity.level,
    reason: sensitivity.reason,
    blocked: sensitivity.level === "block",
  };
}

// Every detection gets a verdict, overlapping detections are merged into one per region,
// each region gets a numbered placeholder, and `safeText` is the page with the blocked
// values already swapped out. This is the object the UI and the API present as "what is
// safe to send on".
export function markSensitivity(words, entities) {
  const claims = entities
    .filter((entity) => Number.isInteger(entity.start) && Number.isInteger(entity.end))
    .map((entity) => ({ ...entity, sensitivity: verdictOf(entity) }));

  // One winner per word: the strongest label covering it. Ranking makes an Aadhaar
  // number that also looks like a phone number stay an Aadhaar number.
  const winner = [];
  for (const claim of claims) {
    for (let index = claim.start; index <= claim.end && index < words.length; index += 1) {
      const current = winner[index];
      if (!current || strength(claim.label) < strength(current.label)) {
        winner[index] = claim;
      }
    }
  }

  // Consecutive words that belong to the same verdict are one region.
  const regions = [];
  for (let index = 0; index < words.length; index += 1) {
    const claim = winner[index];
    if (!claim) {
      continue;
    }
    const previous = regions[regions.length - 1];
    if (previous && previous.end === index - 1 && previous.label === claim.label) {
      previous.end = index;
      previous.confidence = Math.min(previous.confidence, claim.confidence);
      continue;
    }
    regions.push({
      label: claim.label,
      source: claim.source,
      confidence: claim.confidence,
      start: index,
      end: index,
    });
  }

  const counters = new Map();
  const marked = regions.map((region) => {
    const sensitivity = sensitivityOf(region.label);
    const span = words.slice(region.start, region.end + 1);
    // Only blocked data is replaced. Review data keeps its text: a place name is not
    // something a model must not see, and leaving it in is what makes `safeText` useful
    // for the questions that do need it. The entity list still marks it, and the user can
    // black it out from there.
    let redacted = null;
    if (sensitivity.level === "block") {
      const number = (counters.get(sensitivity.placeholder) ?? 0) + 1;
      counters.set(sensitivity.placeholder, number);
      redacted = `[${sensitivity.placeholder}_${number}]`;
    }
    return {
      text: span.map((word) => word.text).join(" "),
      label: region.label,
      source: region.source,
      confidence: region.confidence,
      boxes: [unionBox(span)],
      span: { start: region.start, end: region.end },
      sensitivity,
      redacted,
    };
  });

  const parts = [];
  const byStart = new Map(
    marked.filter((entity) => entity.redacted).map((entity) => [entity.span.start, entity]),
  );
  let index = 0;
  while (index < words.length) {
    const region = byStart.get(index);
    if (region) {
      parts.push(region.redacted);
      index = region.span.end + 1;
      continue;
    }
    parts.push(words[index].text);
    index += 1;
  }

  return {
    entities: marked,
    safeText: parts.join(" "),
    blocked: marked.filter((entity) => entity.sensitivity.level === "block").length,
    review: marked.filter((entity) => entity.sensitivity.level !== "block").length,
  };
}
