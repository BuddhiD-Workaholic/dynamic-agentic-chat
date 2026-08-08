import type { UIMessage } from "ai";

// Paragraphs are addressed BY INDEX, not uuid — the model is shown the canvas
// snapshot and answers about it in the same turn, so the index it reads is
// stable by construction.
export type ScriptNodeData = {
  kind: "script";
  title: string;
  blocks: string[];
  // Bumped only when text is replaced wholesale; the editor is keyed on this
  // to remount with fresh content. Local typing must NOT bump it.
  rev: number;
};

export type ChatNodeData = { kind: "chat" };

// Compact snapshot of the board, sent to the model each turn so it can target
// an existing script ("the Minecraft script") instead of regenerating it.
export type BoardScript = { nodeId: string; title: string; blocks: string[] };

// Sent as a TRANSIENT data part — delivered to onData, never added to
// `messages`, so the chat doesn't re-render per token. `content` is
// accumulated rather than delta'd, so a dropped chunk self-heals on the next.
export type ScriptStreamPayload = {
  nodeId: string;
  // Unique per stream, so a later edit to the same node isn't mistaken for a
  // repeat of an already-finalized one.
  streamId: string;
  title: string;
  content: string;
  // "write" creates a new node. "edit" replaces one paragraph. "rewrite"
  // replaces all paragraphs in place — for changes an edit can't express
  // (deleting/inserting/renumbering items).
  mode: "write" | "edit" | "rewrite";
  blockIndex?: number; // edit mode: which paragraph is being replaced
  // "write" only: which chat bubble caused this node to exist, so the edge can
  // anchor to that message. sourcePrompt is just its text, for a tooltip.
  sourceMessageId?: string;
  sourcePrompt?: string;
  done: boolean;
};

// PERSISTENT, written exactly twice per stream (start, done) — a record in
// the transcript that never carries the body itself.
export type ScriptChipPayload = {
  title: string;
  mode: "write" | "edit" | "rewrite";
  done: boolean;
};

export type MindmapPayload = { topic: string };

// TRANSIENT — live routing status, not kept in the transcript.
export type ToolActivityPayload = {
  tool: string;
  state: "running" | "done";
};

// PERSISTENT, written once at the end of a turn.
export type UsagePayload = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  calls: { label: string; totalTokens: number }[];
};

export type AppDataTypes = {
  script: ScriptStreamPayload;
  scriptChip: ScriptChipPayload;
  mindmap: MindmapPayload;
  tool: ToolActivityPayload;
  usage: UsagePayload;
};

export type AppUIMessage = UIMessage<never, AppDataTypes>;
