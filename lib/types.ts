import type { UIMessage } from "ai";

// A script is an ordered list of paragraphs, addressed BY INDEX.
//
// Index rather than uuid is a deliberate simplification. The model is shown the
// canvas snapshot and answers about it in the same turn, so the index it reads
// is the index we apply — stable by construction. Using uuids here cost three
// separate bugs in the previous design: partial-JSON streaming delivered
// truncated uuid prefixes, local editing re-keyed ids by position anyway, and
// carrying ids through the rich-text editor needed a custom extension.
export type ScriptNodeData = {
  kind: "script";
  title: string;
  blocks: string[];
  // Bumped only when the committed text is replaced wholesale (stream finished).
  // The editor is keyed on this so it remounts with fresh content. Local typing
  // must NOT bump it, or the editor would remount under the user's cursor.
  rev: number;
};

// The chat itself is a node on the canvas, with edges to the scripts it made.
export type ChatNodeData = { kind: "chat" };

// Compact snapshot of the board, sent to the model each turn so it can target
// an existing script ("the Minecraft script") instead of regenerating it.
export type BoardScript = { nodeId: string; title: string; blocks: string[] };

// The live script stream. Sent as a TRANSIENT data part, so it is delivered to
// useChat's onData callback and never added to `messages`.
//
// That distinction is load-bearing. As a normal data part, every token mutates
// the message list, so the chat node re-renders once per token — measured at
// 358 renders for a single paragraph edit. Transient parts leave `messages`
// untouched, so the chat re-renders only when the chip below is written.
//
// `content` is ACCUMULATED rather than a delta. Deltas would halve the bytes,
// but a single dropped chunk would silently corrupt the script, whereas an
// accumulated payload self-heals on the next write.
export type ScriptStreamPayload = {
  nodeId: string;
  // Unique per stream. An edit re-targets an existing nodeId, so nodeId alone
  // cannot tell "still finalizing the last stream" from "a new edit started" —
  // without this, the second edit to a node would be silently ignored.
  streamId: string;
  title: string;
  content: string;
  mode: "write" | "edit";
  blockIndex?: number; // edit mode: which paragraph is being replaced
  done: boolean;
};

// The small, PERSISTENT record of a script action that stays in the chat
// transcript. Written exactly twice per stream (start and done), which is what
// keeps the chat node's render count flat while a script streams — see the note
// on ScriptStreamPayload above.
export type ScriptChipPayload = {
  title: string;
  mode: "write" | "edit";
  done: boolean;
};

export type MindmapPayload = { topic: string };

// What the agent is doing right now. TRANSIENT and ephemeral: routing takes
// several seconds and used to be dead air, so this exists to fill it. It is
// deliberately not kept in the transcript — it is status, not conversation.
export type ToolActivityPayload = {
  tool: string;
  state: "running" | "done";
};

// Token cost of a whole turn, written once at the end. PERSISTENT, because the
// interesting thing about route-then-stream is that it costs more than one
// model call, and hiding that would be dishonest.
export type UsagePayload = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  calls: { label: string; totalTokens: number }[];
};

// Typing the data parts is what makes `npm run typecheck` able to catch SDK
// drift. Untyped, a mistyped part name silently no-ops at runtime forever.
export type AppDataTypes = {
  script: ScriptStreamPayload;
  scriptChip: ScriptChipPayload;
  mindmap: MindmapPayload;
  tool: ToolActivityPayload;
  usage: UsagePayload;
};

export type AppUIMessage = UIMessage<never, AppDataTypes>;
