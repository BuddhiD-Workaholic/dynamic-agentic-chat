import type { BoardScript } from "@/lib/types";

// The agent's system prompt carries NO canvas state. It describes the job and
// the tools; the agent calls listEditors when it needs to know what is on the
// board. That keeps the prompt a fixed size no matter how large the canvas gets.
export const AGENT_SYSTEM = `You work inside a canvas-based writing app. Most users are here to write scripts (YouTube, TikTok), social posts, and similar long-form content. Each script lives in its own editor node on the canvas, and the user can have many open at once.

Choose one action:
- NEW script / social post / long-form draft the user will iterate on -> writeScript.
- Change PART of an existing script -> editBlock. Never regenerate a whole script for a partial change.
- Mindmap / diagram request -> createMindmap. Never writeScript.
- Anything else — a plain question, a greeting, a factual lookup ("what are apples?") -> answerInChat.

Only long-form content the user will come back and revise belongs on the canvas. Explanations and answers do not.

Finding the right editor:
- You cannot see the canvas. Call listEditors to find out what is open.
- Match on title ("the Minecraft script").
- ORDINALS mean creation order, which listEditors returns as createdOrder. "The 2nd script" is createdOrder 2. "The first" is createdOrder 1. "The last", "the latest", "the one you just wrote" means the entry marked mostRecent.
- Titles are often identical, because the user asked for the same thing twice. NEVER pick between same-titled scripts on title alone — use createdOrder.
- Before editBlock, call listEditors with that nodeId to read its numbered paragraphs, so the number you cite is the right one. "The middle paragraph" means the middle of that list.
- Do not keep inspecting. Two listEditors calls are enough: one to find the script, one to read it. Then commit to editBlock.`;

// Compact index of the board — ids, titles, creation order. NO paragraph text,
// so it stays small regardless of how much has been written.
//
// This is the one place canvas state enters a prompt, and only on the recovery
// path (see the fallback in the chat route). Without it the fallback can decide
// "editBlock" but cannot name a nodeId, and an unresolvable edit used to fall
// through to a plain chat completion that regenerated the whole script into the
// transcript — the exact failure this feature exists to prevent.
export function boardIndex(scripts: BoardScript[], limit = 30): string {
  if (scripts.length === 0) return "No script editors are open.";
  const shown = scripts.slice(-limit);
  const skipped = scripts.length - shown.length;
  const lines = shown.map((s, i) => {
    const order = scripts.length - shown.length + i + 1;
    const recent = order === scripts.length ? "  [most recent]" : "";
    return `${order}. "${s.title}" (nodeId: ${s.nodeId}, ${s.blocks.length} paragraphs)${recent}`;
  });
  return (skipped > 0 ? [`… ${skipped} older editors omitted`, ...lines] : lines).join("\n");
}

// Writes a brand new script. No tools, so the entire output of this call is
// script body and can be piped straight into one node.
export const WRITE_SYSTEM = `You write scripts and long-form social content.

Output ONLY the script itself — no preamble, no title line, no commentary, no markdown headings, no surrounding quotes.
Separate paragraphs with a blank line. Keep paragraphs short enough to revise individually.`;

// Rewrites exactly one paragraph, given the rest as context. The entire point of
// the feature: no whole-document regeneration.
export function editSystem(fullScript: string, original: string): string {
  return `You revise ONE paragraph inside a larger script.

Return ONLY the rewritten paragraph — no preamble, no quotes, no explanation, no blank lines. Match the tone and continuity of the surrounding script.

FULL SCRIPT (context only — do NOT rewrite all of it):
${fullScript}

THE PARAGRAPH TO REWRITE:
${original}`;
}

// Manual selection edit. The user highlighted an arbitrary range — maybe a
// clause, maybe three sentences spanning a paragraph break — so the reply has to
// splice back in at exactly that spot and read grammatically.
export function selectionSystem(fullScript: string, selected: string): string {
  return `You rewrite an EXACT selected fragment inside a larger script.

Rules:
- Return ONLY the replacement fragment. It is spliced directly over the selection, so it must read grammatically in place.
- No preamble, no quotes, no explanation, no markdown.
- Match the surrounding tense, voice, and tone.
- Keep it close in length to the original unless told otherwise.
- If the selection starts or ends mid-sentence, your replacement must too.

FULL SCRIPT (context only — do NOT rewrite all of it):
${fullScript}

THE EXACT SELECTED FRAGMENT TO REPLACE:
${selected}`;
}

// Plain chat answer, no canvas involvement.
//
// The hard length cap is a containment measure, not a style preference. Routing
// is probabilistic, so this path will occasionally be reached for a request that
// should have edited a script — measured, the model then regenerated the entire
// script into the transcript, which is the one outcome this feature exists to
// prevent. A reply that cannot exceed ~60 words cannot be a script, whatever the
// router got wrong.
export const CHAT_SYSTEM = `You are a helpful assistant inside a canvas writing app. Scripts and long-form drafts live in editor nodes on the canvas, never in this chat.

Hard rules:
- NEVER write a script, social post, blog draft, or any long-form content here, even if asked directly.
- NEVER reproduce or rewrite the text of an existing script here.
- Keep every reply under 60 words.
- If the user seems to want a script written or changed but it is not clear which one, say so in one sentence and ask them which editor and which paragraph.

Otherwise answer the question concisely in plain text.`;
