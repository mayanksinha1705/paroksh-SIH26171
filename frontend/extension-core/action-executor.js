(function () {
  // Google Forms (and most modern form UIs) build radio/checkbox/dropdown
  // questions out of styled <div role="radio">/"checkbox"/"option"/"listbox">
  // rather than native <input>. The original selector only matched
  // button/link/input/select/contenteditable, so every custom-control
  // question on a Google Form was completely invisible to the manifest —
  // the agent wasn't skipping those fields, it never saw them to begin with.
  const INTERACTIVE_SELECTOR = 'button, [role="button"], a, input, textarea, select, [contenteditable="true"], [role="textbox"], [onclick], [role="radio"], [role="checkbox"], [role="option"], [role="listbox"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="switch"], [role="combobox"], [aria-checked]';
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const TYPE_SPEED_MIN = 10, TYPE_SPEED_MAX = 30, SETTLE_TIME = 150;

  function normalize(t) { return String(t || "").trim().toLowerCase(); }
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (window.getComputedStyle(el).display === 'none' || window.getComputedStyle(el).visibility === 'hidden') return false;
    // Only count elements actually within the current scroll viewport.
    // Previously this let off-screen elements (already scrolled past, or
    // further down a long form) into the manifest with coordinates that
    // didn't match the screenshot at all — the model would try to act on
    // (or scroll toward) a field it thought was still visible, and the
    // fixed 50-element cap got eaten up by off-screen elements, crowding
    // out fields that WERE currently on screen.
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
    if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
    return true;
  }

  function deepQuerySelectorAll(selector, root = document) {
    const results = Array.from(root.querySelectorAll(selector));
    root.querySelectorAll("*").forEach(el => { if (el.shadowRoot) results.push(...deepQuerySelectorAll(selector, el.shadowRoot)); });
    return results;
  }

  function labelFor(el) {
    const context = fieldContext(el).toLowerCase();
    if (/\bpan(?:\s*(?:card|number|no))?\b/.test(context)) return "[PAN]";
    if (/\b(aadhaar|aadhar|uidai)\b|आधार/u.test(context)) return "[AADHAAR]";
    if (/\b(dob|date\s+of\s+birth|birth|birthday)\b|जन्म/u.test(context)) return "[DOB]";
    if (/\b(phone|mobile|telephone|tel|contact)\b|फोन|मोबाइल|संपर्क/u.test(context)) return "[PHONE]";
    if (/\b(email|e-mail|mail)\b|ईमेल|मेल/u.test(context)) return "[EMAIL]";
    if (/\b(card|credit\s+card|debit\s+card|cvv|atm)\b/u.test(context)) return "[CARD]";
    if (/\b(address|street|residence)\b|पता/u.test(context)) return "[ADDRESS]";
    if (/\b(full\s+name|name|father|mother)\b|नाम|पिता|माता/u.test(context)) return "[PERSON]";
    if (el.matches('input[type="date"], input[autocomplete="bday"]')) return "[DOB]";
    if (el.matches([
      'input[type="password"]',
      'textarea[autocomplete="current-password"]',
      'input[autocomplete="new-password"]',
      'input[type="email"]',
      'input[type="tel"]',
      'input[autocomplete*="email"]',
      'input[autocomplete*="tel"]',
      'input[autocomplete*="cc-"]',
      'input[autocomplete="street-address"]',
      'input[autocomplete="postal-code"]',
    ].join(','))) {
      const type = el.getAttribute("type") || "";
      const autocomplete = el.getAttribute("autocomplete") || "";
      if (type === "email" || autocomplete.includes("email")) return "[EMAIL]";
      if (type === "tel" || autocomplete.includes("tel")) return "[PHONE]";
      if (autocomplete.includes("cc-")) return "[CARD]";
      if (autocomplete.includes("address") || autocomplete.includes("postal")) return "[ADDRESS]";
      return "[PASSWORD]";
    }
    return `[${(el.getAttribute("role") || el.tagName || "ELEMENT").toUpperCase()}]`;
  }

  function isSensitiveElement(el) {
    const context = fieldContext(el).toLowerCase();
    if (DOM_SENSITIVE_FIELD_PATTERN.test(context)) return true;
    return el.matches([
      'input[type="date"]',
      'input[autocomplete="bday"]',
      'input[type="password"]',
      'textarea[autocomplete="current-password"]',
      'input[autocomplete="new-password"]',
      'input[type="email"]',
      'input[type="tel"]',
      'input[autocomplete*="email"]',
      'input[autocomplete*="tel"]',
      'input[autocomplete*="cc-"]',
      'input[autocomplete="street-address"]',
      'input[autocomplete="postal-code"]',
    ].join(','));
  }

  const DOM_PAN_PATTERN = /\b[A-Z]{5}\s*\d{4}\s*[A-Z]\b/iu;
  const DOM_PII_PATTERNS = [
    ["EMAIL", /[^\s@]+@[^\s@]+\.[A-Z]{2,}/iu],
    ["PHONE", /(?:\+91[\s-]?)?[6-9]\d{9}\b/u],
    ["PAN", /\b[A-Z]{5}\s*\d{4}\s*[A-Z]\b/iu],
    ["AADHAAR", /\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/u],
    ["CARD", /\b(?:\d{4}[\s-]?){3}\d{4}\b/u],
    ["DOB", /\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{2,4})\b/iu],
  ];
  const DOM_SENSITIVE_FIELD_PATTERN = /\b(address|addr|street|city|state|district|village|country|pin|pincode|postal|zip|dob|birth|birthday|religion|aadhaar|aadhar|uidai|pan|phone|mobile|email|contact|name|father|mother)\b|पता|शहर|राज्य|जिला|पिन|जन्म|धर्म|नाम|आधार/iu;

  function fieldContext(el) {
    const parts = [
      el.getAttribute("aria-label"),
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("placeholder"),
      el.getAttribute("autocomplete"),
      el.getAttribute("type"),
    ];
    const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (id) parts.push(id.textContent);
    const parentLabel = el.closest("label");
    if (parentLabel) parts.push(parentLabel.textContent);
    const previous = el.previousElementSibling;
    if (previous && previous.textContent && previous.textContent.length <= 120) {
      parts.push(previous.textContent);
    }
    let ancestor = el.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
      const text = String(ancestor.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 240) parts.push(text);
    }
    return parts.filter(Boolean).join(" ");
  }

  function addRect(matches, label, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    matches.push({ label, x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }

  function getSensitiveDomRects() {
    const candidates = deepQuerySelectorAll("body *").filter(isVisible);
    const matches = [];
    for (const el of candidates) {
      const value = String(el.value || "").trim();
      const context = fieldContext(el);
      if (value && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
        && (DOM_SENSITIVE_FIELD_PATTERN.test(context) || isSensitiveElement(el))) {
        addRect(matches, context.toLowerCase().includes("pan") ? "PAN" : "PII", el.getBoundingClientRect());
      }
      const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 300) continue;
      if (DOM_PAN_PATTERN.test(text)) {
        const childMatch = Array.from(el.children).some((child) => DOM_PAN_PATTERN.test(String(child.textContent || "")));
        if (!childMatch) addRect(matches, "PAN", el.getBoundingClientRect());
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || !isVisible(parent) || !node.nodeValue?.trim()) continue;
      for (const [label, pattern] of DOM_PII_PATTERNS) {
        const match = pattern.exec(node.nodeValue);
        if (!match) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        addRect(matches, label, range.getBoundingClientRect());
      }
    }
    return matches;
  }

  let markedElements = [];

  function getElementRects() {
    const candidates = deepQuerySelectorAll(INTERACTIVE_SELECTOR).filter(isVisible);
    const kept = [];
    for (const el of candidates) {
      if (isSensitiveElement(el) || !kept.some(other => other.contains(el))) kept.push(el);
    }
    markedElements = [];
    const manifest = kept.slice(0, 50).map((el, idx) => {
      const id = idx + 1;
      const rect = el.getBoundingClientRect();
      markedElements.push({ id, el });
      return {
        id,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        type: el.getAttribute("type") || "",
        autocomplete: el.getAttribute("autocomplete") || "",
        label: labelFor(el),
        category: labelFor(el).slice(1, -1),
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });
    return {
      elements: manifest,
      sensitiveRects: getSensitiveDomRects(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }

  function resolveElement(action, selector) {
    let el = markedElements.find(m => m.id === action.element_id)?.el;
    if (el) return el;
    const candidates = deepQuerySelectorAll(selector).filter(isVisible);
    el = candidates.find(c => normalize(labelFor(c)).includes(normalize(action.target)) || normalize(action.target).includes(normalize(labelFor(c))));
    if (el) return el;
    if (action.x != null && action.y != null) el = document.elementFromPoint(action.x, action.y);
    return el || null;
  }

  async function showClickAnimation(el) {
    const rect = el.getBoundingClientRect();
    const dot = document.createElement('div');
    dot.style.cssText = `position:fixed; top:${rect.top + rect.height/2}px; left:${rect.left + rect.width/2}px; width:20px; height:20px; background:rgba(66,133,244,0.6); border-radius:50%; pointer-events:none; z-index:2147483647; transform:translate(-50%,-50%); transition:all 0.3s ease-out;`;
    document.body.appendChild(dot);
    await sleep(10);
    dot.style.width = '40px'; dot.style.height = '40px'; dot.style.opacity = '0';
    setTimeout(() => dot.remove(), 300);
  }

  // ---------------------------------------------------------------------
  // Completion verification
  //
  // Previously the model's own {"action":"DONE"} was trusted blindly by
  // background.js — there was no code-side check that a form had actually
  // been submitted. A model that gets over-confident mid-form (a very
  // common failure mode on long multi-question pages) would just end the
  // run there, and the extension reported success on an incomplete form.
  // This gives background.js real signal to check against before it
  // accepts DONE, instead of relying purely on the model self-grading.
  // ---------------------------------------------------------------------
  const FORM_CONFIRMATION_PHRASES = [
    "response has been recorded",
    "response was recorded",
    "recorded your response",
    "response has been submitted",
    "your response has been received",
    "submit another response",
    "thanks for filling out this form",
    "thank you for completing",
    "thank you for your submission",
    "form submitted",
  ];

  function isGoogleFormsPage() {
    return location.hostname.includes("docs.google.com") && location.pathname.includes("/forms/");
  }

  function isConfirmationVisible() {
    const text = normalize(document.body.innerText).slice(0, 6000);
    return FORM_CONFIRMATION_PHRASES.some(p => text.includes(p));
  }

  function hasUnfilledNativeRequiredFields() {
    // Native <form required> fields (checkout pages, college portals, plain
    // HTML surveys) expose real browser validity we can check directly,
    // without needing per-site heuristics.
    return Array.from(document.forms).some(f => typeof f.checkValidity === "function" && !f.checkValidity());
  }

  function verifyCompletion() {
    const googleForm = isGoogleFormsPage();
    return {
      isGoogleForm: googleForm,
      confirmed: googleForm ? isConfirmationVisible() : true,
      hasUnfilledRequired: hasUnfilledNativeRequiredFields(),
    };
  }

  async function doClick(action) {
    const el = resolveElement(action, 'button, [role="button"], a, input[type="submit"], [onclick], [role="radio"], [role="checkbox"], [role="option"], [role="listbox"], [aria-checked]');
    if (!el) throw new Error("Element not found");
    el.scrollIntoView({ block: "center", behavior: "auto" });
    await sleep(SETTLE_TIME);
    await showClickAnimation(el);
    el.click();
    return `Clicked ${action.target || "element"}`;
  }

  async function doType(action) {
    if (window.location.hostname.includes("docs.google.com")) throw new Error("TRUSTED_INPUT_REQUIRED");
    const el = resolveElement(action, 'input, textarea, [contenteditable="true"], [role="textbox"]');
    if (!el) throw new Error("Field not found");
    const existingValue = el.isContentEditable ? el.innerText : el.value;
    if (String(existingValue || "").trim()) {
      return `Skipped ${action.target || "field"} because it is already filled`;
    }
    el.focus();
    const text = action.text || "";
    if (el.isContentEditable) {
      el.innerText = "";
      for (let i = 1; i <= text.length; i++) {
        el.innerText = text.slice(0, i);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(Math.random() * (TYPE_SPEED_MAX - TYPE_SPEED_MIN) + TYPE_SPEED_MIN);
      }
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Typed ${action.text}`;
  }

  async function doSelect(action) {
    const el = resolveElement(action, 'select');
    if (!el || el.tagName !== "SELECT") throw new Error("Select element not found");
    const target = normalize(action.value);
    const options = Array.from(el.options);
    const match = options.find(o => normalize(o.text) === target || normalize(o.value) === target)
      || options.find(o => normalize(o.text).includes(target) || target.includes(normalize(o.text)));
    el.value = match ? match.value : action.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Selected ${action.value}`;
  }

  async function doKey(action) {
    // Synthetic key event (same as the original working extension). Note the
    // browser won't run its own default action for an untrusted key event on
    // most sites, so background.js sends KEY as a real CDP key press first
    // and only calls this if the debugger couldn't attach.
    const el = document.activeElement || document.body;
    const key = action.key || "Enter";
    const opts = { key, bubbles: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    return `Pressed ${key}`;
  }

  async function doHover(action) {
    // Page-level hover: dispatches mouseover/mouseenter/mousemove on the
    // element found by element_id. (background.js falls back to a real CDP
    // mouseMoved only if this fails and the model supplied x/y.)
    const el = resolveElement(action, INTERACTIVE_SELECTOR);
    if (!el) throw new Error("Element not found");
    el.scrollIntoView({ block: "center", behavior: "auto" });
    await sleep(SETTLE_TIME);
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    return `Hovered ${action.target || "element"}`;
  }

  function scrollAmount(action) {
    const parsed = typeof action.amount === "string"
      ? Number.parseFloat(action.amount)
      : Number(action.amount);
    if (!Number.isFinite(parsed)) return 500;
    return Math.min(Math.max(Math.abs(parsed), 0), 2000);
  }

  function scrollTarget() {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) {
      let candidate = active;
      while (candidate && candidate !== document.body) {
        const style = window.getComputedStyle(candidate);
        if ((style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "overlay") &&
          candidate.scrollHeight > candidate.clientHeight) {
          return candidate;
        }
        candidate = candidate.parentElement;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  async function doScroll(action) {
    const amount = scrollAmount(action);
    if (amount === 0) {
      await sleep(SETTLE_TIME);
      return "Scrolled";
    }

    const delta = String(action.direction || "").toLowerCase() === "up" ? -amount : amount;
    const root = document.scrollingElement || document.documentElement;
    const target = scrollTarget();

    if (target === root || target === document.body) {
      window.scrollBy({ top: delta, left: 0, behavior: "auto" });
    } else {
      target.scrollBy({ top: delta, left: 0, behavior: "auto" });
      // Some custom scroll containers ignore Element.scrollBy but still
      // respond to direct scrollTop updates.
      if (target.scrollTop === 0 && delta > 0) target.scrollTop = delta;
    }
    await sleep(SETTLE_TIME);
    return `Scrolled ${delta > 0 ? "down" : "up"} ${amount}px`;
  }

  async function execute(action) {
    switch (action.action) {
      case "CLICK": return await doClick(action);
      case "TYPE": return await doType(action);
      case "SELECT": return await doSelect(action);
      case "KEY": return await doKey(action);
      case "HOVER": return await doHover(action);
      case "SCROLL": return await doScroll(action);
      case "NAVIGATE": return `Navigating...`;
      default: throw new Error("Unsupported action");
    }
  }

  window.AIAgentExecutor = { execute, getElementRects, verifyCompletion };
})();
