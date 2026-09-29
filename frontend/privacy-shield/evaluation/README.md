# PrivacyShield evaluation set

Create a JSON file with 10–20 manually labeled screenshots. Each case records the
entity types that are actually present and the types PrivacyShield detected:

```json
[
  { "name": "email-form-01", "expected": ["EMAIL"], "detected": ["EMAIL"] },
  { "name": "login-02", "expected": ["PASSWORD"], "detected": ["PASSWORD"] },
  { "name": "clean-news-03", "expected": [], "detected": [] }
]
```

Use the exact uppercase labels emitted by the pipeline (`EMAIL`, `PHONE`, `PER`,
`ADDRESS`, `PASSWORD`, and so on). Run:

```bash
node frontend/privacy-shield/evaluation/evaluate.mjs labels.json
```

The script reports micro precision, recall, and F1. It treats each entity type as
one detection per screenshot, which makes the result easy to audit during a demo.
