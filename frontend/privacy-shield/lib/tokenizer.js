// A port of the slow Python `transformers.BertTokenizer` (BasicTokenizer + WordPiece)
// driven by `vocab.txt` alone. There is no `tokenizer.json` in this repository and
// `vocab.txt` is regenerated so that its line number equals the token id (see README),
// which is what makes a plain vocabulary file sufficient here.
//
// Ported behaviour that is load-bearing: Devanagari vowel signs are category `Mn`, not
// punctuation, so they are never split off a word — a pre-tokenizer that splits on
// "not a letter or digit" turns दिल्ली into द + ल्ली and matches nothing. Lowercasing
// and accent stripping stay off too, because accents are letters in Indic scripts.

// `BertTokenizer.all_special_tokens`, in the order transformers reports them.
const ALL_SPECIAL_TOKENS = ["[UNK]", "[SEP]", "[PAD]", "[CLS]", "[MASK]"];

const CONTROL = /\p{C}/u;
const SPACE_SEPARATOR = /\p{Zs}/u;
const PUNCTUATION = /\p{P}/u;
const NON_SPACING_MARK = /\p{Mn}/u;
// Everything `str.isspace()` accepts in Python, i.e. `str.split()` with no arguments.
// The plain space is listed first: without it every multi-word sentence stays one
// "word" and WordPiece turns it into a single `[UNK]`.
const PYTHON_WHITESPACE_RUN =
  /[ \t\n\v\f\r\x1c-\x1f\x85\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

function isWhitespace(character) {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    SPACE_SEPARATOR.test(character)
  );
}

function isControl(character) {
  if (character === "\t" || character === "\n" || character === "\r") {
    return false;
  }
  return CONTROL.test(character);
}

function isPunctuation(character) {
  const codePoint = character.codePointAt(0);
  // The ASCII ranges matter: $ + < = > ^ ` | ~ are symbols, not `P` categories, yet
  // BERT still splits on them.
  if (
    (codePoint >= 33 && codePoint <= 47) ||
    (codePoint >= 58 && codePoint <= 64) ||
    (codePoint >= 91 && codePoint <= 96) ||
    (codePoint >= 123 && codePoint <= 126)
  ) {
    return true;
  }
  return PUNCTUATION.test(character);
}

function isChineseCharacter(codePoint) {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x2f800 && codePoint <= 0x2fa1f)
  );
}

function stripAccentsFrom(text) {
  return Array.from(text.normalize("NFD"))
    .filter((character) => !NON_SPACING_MARK.test(character))
    .join("");
}

// `whitespace_tokenize()` from transformers.
function whitespaceTokens(text) {
  return text.split(PYTHON_WHITESPACE_RUN).filter((token) => token.length > 0);
}

function pad(values, width, fill) {
  const padded = values.slice();
  while (padded.length < width) {
    padded.push(fill);
  }
  return padded;
}

function splitOnPunctuation(text, neverSplit) {
  if (neverSplit.has(text)) {
    return [text];
  }
  const output = [];
  let startNewWord = true;
  for (const character of text) {
    if (isPunctuation(character)) {
      output.push([character]);
      startNewWord = true;
    } else {
      if (startNewWord) {
        output.push([]);
      }
      startNewWord = false;
      output[output.length - 1].push(character);
    }
  }
  return output.map((group) => group.join(""));
}


class BasicTokenizer {
  constructor({ doLowerCase, neverSplit, tokenizeChineseChars, stripAccents }) {
    this.doLowerCase = doLowerCase;
    this.neverSplit = neverSplit;
    this.tokenizeChineseChars = tokenizeChineseChars;
    this.stripAccents = stripAccents;
  }

  tokenize(text) {
    let cleaned = "";
    for (const character of text) {
      const codePoint = character.codePointAt(0);
      if (codePoint === 0 || codePoint === 0xfffd || isControl(character)) {
        continue;
      }
      cleaned += isWhitespace(character) ? " " : character;
    }
    if (this.tokenizeChineseChars) {
      cleaned = this.#surroundChineseCharacters(cleaned);
    }

    const splitTokens = [];
    for (const original of whitespaceTokens(cleaned.normalize("NFC"))) {
      let token = original;
      if (!this.neverSplit.has(token)) {
        if (this.doLowerCase) {
          token = token.toLowerCase();
          if (this.stripAccents !== false) {
            token = stripAccentsFrom(token);
          }
        } else if (this.stripAccents) {
          token = stripAccentsFrom(token);
        }
      }
      splitTokens.push(...splitOnPunctuation(token, this.neverSplit));
    }
    return whitespaceTokens(splitTokens.join(" "));
  }

  #surroundChineseCharacters(text) {
    let output = "";
    for (const character of text) {
      if (isChineseCharacter(character.codePointAt(0))) {
        output += ` ${character} `;
      } else {
        output += character;
      }
    }
    return output;
  }
}

class WordpieceTokenizer {
  constructor({ vocab, unkToken, maxInputCharsPerWord }) {
    this.vocab = vocab;
    this.unkToken = unkToken;
    this.maxInputCharsPerWord = maxInputCharsPerWord;
  }

  tokenize(text) {
    const outputTokens = [];
    for (const token of whitespaceTokens(text)) {
      const characters = Array.from(token);
      if (characters.length > this.maxInputCharsPerWord) {
        outputTokens.push(this.unkToken);
        continue;
      }

      let isBad = false;
      let start = 0;
      const subTokens = [];
      while (start < characters.length) {
        let end = characters.length;
        let currentSubstring = null;
        while (start < end) {
          let substring = characters.slice(start, end).join("");
          if (start > 0) {
            substring = `##${substring}`;
          }
          if (this.vocab.has(substring)) {
            currentSubstring = substring;
            break;
          }
          end -= 1;
        }
        if (currentSubstring === null) {
          isBad = true;
          break;
        }
        subTokens.push(currentSubstring);
        start = end;
      }

      if (isBad) {
        outputTokens.push(this.unkToken);
      } else {
        outputTokens.push(...subTokens);
      }
    }
    return outputTokens;
  }
}

export class BertTokenizer {
  // Browser port of `fromVocabFile()`: the vocabulary is fetched instead of read off
  // disk, since there is no filesystem in the page. `vocabUrl` is resolved the same way
  // an <img src> or <script src> would be, so a relative path works from any deployment
  // root.
  static async fromVocabUrl(
    vocabUrl,
    {
      doLowerCase = false,
      tokenizeChineseChars = true,
      stripAccents = null,
      maxInputCharsPerWord = 100,
      unkToken = "[UNK]",
    } = {},
  ) {
    const response = await fetch(vocabUrl);
    if (!response.ok) {
      throw new Error(`Could not fetch ${vocabUrl} (HTTP ${response.status}).`);
    }
    const text = await response.text();
    return BertTokenizer.fromVocabText(text, {
      doLowerCase,
      tokenizeChineseChars,
      stripAccents,
      maxInputCharsPerWord,
      unkToken,
    });
  }

  // Same construction, from an already-loaded vocabulary string. Split out so a cached
  // copy (see lib/cache.js) can be handed straight in without a second fetch.
  static fromVocabText(
    vocabText,
    {
      doLowerCase = false,
      tokenizeChineseChars = true,
      stripAccents = null,
      maxInputCharsPerWord = 100,
      unkToken = "[UNK]",
    } = {},
  ) {
    const lines = vocabText.split(/\r?\n/);
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    // Line number == token id. Setting ascending ids means a duplicated token keeps
    // the last line's id, matching `OrderedDict(zip(vocab, range(len(vocab))))`.
    const tokenToId = new Map();
    lines.forEach((token, id) => tokenToId.set(token, id));
    return new BertTokenizer({
      tokens: lines,
      tokenToId,
      doLowerCase,
      tokenizeChineseChars,
      stripAccents,
      maxInputCharsPerWord,
      unkToken,
    });
  }

  constructor({
    tokens,
    tokenToId,
    doLowerCase,
    tokenizeChineseChars,
    stripAccents,
    maxInputCharsPerWord,
    unkToken,
  }) {
    this.tokens = tokens;
    this.tokenToId = tokenToId;
    this.unkToken = unkToken;
    this.unkTokenId = this.#requiredTokenId(unkToken);
    this.padTokenId = this.#requiredTokenId("[PAD]");
    this.clsTokenId = this.#requiredTokenId("[CLS]");
    this.sepTokenId = this.#requiredTokenId("[SEP]");
    this.maskTokenId = this.#requiredTokenId("[MASK]");
    // Special tokens are never split and never handed to WordPiece, so text that
    // already contains "[SEP]" survives tokenization intact.
    this.neverSplit = new Set(ALL_SPECIAL_TOKENS);
    this.basicTokenizer = new BasicTokenizer({
      doLowerCase,
      neverSplit: this.neverSplit,
      tokenizeChineseChars,
      stripAccents,
    });
    this.wordpieceTokenizer = new WordpieceTokenizer({
      vocab: tokenToId,
      unkToken,
      maxInputCharsPerWord,
    });
  }

  get vocabSize() {
    return this.tokens.length;
  }

  tokenize(text) {
    const splitTokens = [];
    for (const token of this.basicTokenizer.tokenize(text)) {
      if (this.neverSplit.has(token)) {
        splitTokens.push(token);
      } else {
        splitTokens.push(...this.wordpieceTokenizer.tokenize(token));
      }
    }
    return splitTokens;
  }

  // `convert_tokens_to_ids()`, falling back to the unknown token like `vocab.get()`.
  convertTokensToIds(tokens) {
    return tokens.map((token) => this.convertTokenToId(token));
  }

  convertTokenToId(token) {
    const id = this.tokenToId.get(token);
    return id === undefined ? this.unkTokenId : id;
  }

  // `convert_ids_to_tokens()`; ids outside the vocabulary become the unknown token.
  convertIdToToken(id) {
    return this.tokens[id] ?? this.unkToken;
  }

  convertIdsToTokens(ids) {
    return ids.map((id) => this.convertIdToToken(id));
  }

  // Single sequence, mirroring `tokenizer(text, truncation=True, max_length=512)`.
  encode(text, { truncation = false, maxLength = null, addSpecialTokens = true } = {}) {
    return this.#buildSequence(text, { truncation, maxLength, addSpecialTokens });
  }

  // Mirrors `tokenizer(texts, padding=True, truncation=True, max_length=512)`: with
  // `padding` every row is extended to the longest row of the batch using `[PAD]`.
  encodeBatch(
    texts,
    { padding = false, truncation = false, maxLength = null, addSpecialTokens = true } = {},
  ) {
    const rows = texts.map((text) =>
      this.#buildSequence(text, { truncation, maxLength, addSpecialTokens }),
    );
    if (!padding) {
      return rows;
    }
    const width = Math.max(...rows.map((row) => row.inputIds.length));
    return rows.map((row) => ({
      inputIds: pad(row.inputIds, width, this.padTokenId),
      attentionMask: pad(row.attentionMask, width, 0),
      tokenTypeIds: pad(row.tokenTypeIds, width, 0),
    }));
  }

  #buildSequence(text, { truncation, maxLength, addSpecialTokens }) {
    const tokens = this.tokenize(text);
    // transformers truncates to `max_length - num_special_tokens_to_add` and only then
    // re-adds [CLS] and [SEP], so an encoded sequence is exactly `maxLength` long.
    const budget = maxLength === null ? null : maxLength - (addSpecialTokens ? 2 : 0);
    const kept = truncation && budget !== null ? tokens.slice(0, Math.max(budget, 0)) : tokens;
    const inputIds = addSpecialTokens
      ? [this.clsTokenId, ...this.convertTokensToIds(kept), this.sepTokenId]
      : this.convertTokensToIds(kept);
    return {
      inputIds,
      attentionMask: inputIds.map(() => 1),
      tokenTypeIds: inputIds.map(() => 0),
    };
  }

  #requiredTokenId(token) {
    const id = this.tokenToId.get(token);
    if (id === undefined) {
      throw new Error(`vocabulary is missing the special token ${token}`);
    }
    return id;
  }
}
