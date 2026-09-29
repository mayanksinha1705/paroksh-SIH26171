import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node evaluate.mjs <labels.json>");
  process.exit(2);
}

const cases = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(cases) || cases.length === 0) {
  throw new Error("The evaluation file must contain at least one case.");
}

let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;

for (const item of cases) {
  const expected = new Set((item.expected || []).map((label) => String(label).toUpperCase()));
  const detected = new Set((item.detected || []).map((label) => String(label).toUpperCase()));
  for (const label of detected) {
    if (expected.has(label)) truePositive += 1;
    else falsePositive += 1;
  }
  for (const label of expected) {
    if (!detected.has(label)) falseNegative += 1;
  }
}

const precision = truePositive / Math.max(truePositive + falsePositive, 1);
const recall = truePositive / Math.max(truePositive + falseNegative, 1);
const f1 = (2 * precision * recall) / Math.max(precision + recall, Number.EPSILON);

console.log(JSON.stringify({
  cases: cases.length,
  truePositive,
  falsePositive,
  falseNegative,
  precision: Number(precision.toFixed(4)),
  recall: Number(recall.toFixed(4)),
  f1: Number(f1.toFixed(4)),
}, null, 2));
