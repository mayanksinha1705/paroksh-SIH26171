// ollama2.js
//
// ollama.js is the "hands" of the agent — it's forced to speak in strict,
// silent JSON (no markdown, no explanation) so the automation loop in
// background.js can parse it reliably. That's great for clicking buttons,
// terrible for a chat window: the user would only ever see raw JSON or a
// blank/terse "summary" field.
//
// This file is the "voice". It's a completely separate Ollama call with its
// own system prompt, so the two never get mixed up. It takes whatever the
// automation loop actually did (the instruction + the raw step/summary log)
// and rewrites it as a short, first-person, human chat reply — the kind of
// thing a helpful assistant would actually say back to you.

export const CHAT_MODEL = "gemma4:31b-cloud";
export const OLLAMA_HOST = "http://localhost:11434";
export const OLLAMA_CHAT_ENDPOINT = `${OLLAMA_HOST}/api/chat`;

const CHAT_SYSTEM_PROMPT = `You are PAROKSH, a friendly browser-automation assistant talking to a user in a chat sidebar.

You are told what the user asked for, whether it succeeded or failed, and the raw internal log from the automation step that just ran (this log may contain step names, JSON, or terse status text — it is NOT meant to be shown to the user as-is).

Your only job is to reply the way a helpful human assistant would report back after doing something for someone. Rules:
- Write 1-3 short sentences, first person ("I've...", "I opened...", "I typed...").
- NEVER output JSON, code fences, or raw field/action names like CLICK, TYPE, SCROLL, DONE, ERROR.
- Don't just repeat the raw log verbatim — summarize it naturally, like you're describing what you did to a person, not printing a log.
- If it succeeded: briefly say what you did, then invite the next request in a natural, varied way (don't reuse the exact same closing line every time).
- If it failed: briefly and plainly say what went wrong (no jargon), apologize once, and ask how they'd like to proceed.
- Never invent steps that aren't implied by the log.
- Plain text only. Nothing before or after it.`;

function buildUserPrompt(instruction, rawLog, success) {
  return [
    `User's request: "${instruction}"`,
    `Outcome: ${success ? "SUCCESS" : "FAILURE"}`,
    `Raw internal log (for your reference only, do not repeat it as-is):\n${rawLog || "(none)"}`,
  ].join("\n\n");
}

function stripStrayFormatting(text) {
  return text
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .trim();
}

function fallbackReply(rawLog, success) {
  // Used only if the chat model call itself fails, so the user is never
  // shown nothing at all.
  if (success) {
    const lastStep = String(rawLog || "").split("→").pop().trim();
    return `Done — ${lastStep || "that's finished"}. Anything else you'd like me to do?`;
  }
  return `I ran into a problem: ${rawLog || "something went wrong"}. Want me to try a different approach?`;
}

/**
 * Turns the automation loop's raw result into a natural chat message.
 * Never throws — on any failure it falls back to a plain, still-human string.
 */
export async function getHumanReply(instruction, rawLog, success = true) {
  const requestBody = {
    model: CHAT_MODEL,
    stream: false,
    options: { temperature: 0.6, num_predict: 150 },
    messages: [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(instruction, rawLog, success) },
    ],
  };

  try {
    const response = await fetch(OLLAMA_CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) throw new Error(`Ollama chat error: ${response.status}`);
    const payload = await response.json();
    const text = stripStrayFormatting(payload?.message?.content || "");
    if (!text) throw new Error("Empty reply from chat model");
    return text;
  } catch (err) {
    console.warn("PAROKSH: ollama2 chat reply failed, using fallback:", err.message);
    return fallbackReply(rawLog, success);
  }
}
