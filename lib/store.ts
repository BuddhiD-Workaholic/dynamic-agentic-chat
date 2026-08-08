import { create } from "zustand";
import { applyNodeChanges, type Edge, type Node, type NodeChange } from "@xyflow/react";
import type {
  BoardScript,
  ChatNodeData,
  ScriptNodeData,
  ScriptStreamPayload,
} from "@/lib/types";

export const CHAT_NODE_ID = "chat";

// Board layout, in flow coordinates. Chat sits left-of-centre with its own
// margin; SCRIPT.x clears the chat's right edge by 180px so new nodes open
// in clear columns beside it, never tucked underneath.
const CHAT = { x: 380, y: 140, w: 400, h: 560 };
const SCRIPT = { x: 960, y: 40, w: 360, h: 440, colGap: 420, rowGap: 470, rows: 2 };

// Lives outside the `nodes` array on purpose: per-token updates touch only
// `buffers[nodeId]`, so only the one node selecting that slice re-renders.
type Buffer = {
  streamId: string;
  title: string;
  content: string;
  mode: "write" | "edit" | "rewrite";
  blockIndex?: number;
  streaming: boolean;
};

type CanvasState = {
  nodes: Node[];
  edges: Edge[];
  buffers: Record<string, Buffer>;

  onNodesChange: (changes: NodeChange[]) => void;
  getBoardScripts: () => BoardScript[];

  applyScript: (p: ScriptStreamPayload) => void;

  // Live tool-call status for the current turn, cleared when the next starts.
  toolActivity: { tool: string; state: "running" | "done" }[];
  noteToolActivity: (tool: string, state: "running" | "done") => void;
  clearToolActivity: () => void;

  // Free typing in the editor, synced back so the model's canvas snapshot stays
  // truthful. Must NOT bump `rev` — that would remount the editor mid-typing.
  commitLocalText: (nodeId: string, blocks: string[]) => void;

  // A failed stream must never leave a node stuck in the read-only streaming
  // view with no way back. Commits whatever arrived and releases the node.
  settleStreams: () => void;
};

export const toBlocks = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean);

function commit(nodes: Node[], nodeId: string, buf: Buffer): Node[] {
  return nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const d = n.data as ScriptNodeData;
    const text = buf.content.trim();
    // Only "edit" is surgical. "write" and "rewrite" both deliver a whole
    // script; they differ solely in whether the node already existed.
    const blocks =
      buf.mode === "edit"
        ? d.blocks.map((b, i) => (i === buf.blockIndex ? text : b))
        : toBlocks(buf.content);
    return {
      ...n,
      data: {
        kind: "script",
        title: buf.title || d.title,
        blocks: blocks.length > 0 ? blocks : d.blocks,
        rev: d.rev + 1,
      } satisfies ScriptNodeData,
    };
  });
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],
  buffers: {},

  onNodesChange: (changes) =>
    set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) })),

  getBoardScripts: () =>
    get()
      .nodes.filter((n) => (n.data as { kind?: string }).kind === "script")
      .map((n) => {
        const d = n.data as ScriptNodeData;
        return { nodeId: n.id, title: d.title, blocks: d.blocks };
      }),

  applyScript: (p) =>
    set((s) => {
      const existing = s.buffers[p.nodeId];

      // Ignore repeats of an already-finalized stream — otherwise the final
      // payload re-commits forever, bumping `rev` and remounting the editor.
      if (existing?.streamId === p.streamId && !existing.streaming) return s;

      let nodes = s.nodes;
      let edges = s.edges;

      // First sight of a new script. Guarded on "write" — a rewrite targets a
      // node that already exists and must never spawn a second one.
      if (p.mode === "write" && !nodes.some((n) => n.id === p.nodeId)) {
        const count = nodes.filter(
          (n) => (n.data as { kind?: string }).kind === "script",
        ).length;
        const col = Math.floor(count / SCRIPT.rows);
        const row = count % SCRIPT.rows;
        nodes = [
          ...nodes,
          {
            id: p.nodeId,
            type: "script",
            position: {
              x: SCRIPT.x + col * SCRIPT.colGap,
              y: SCRIPT.y + row * SCRIPT.rowGap,
            },
            width: SCRIPT.w,
            height: SCRIPT.h,
            data: {
              kind: "script",
              title: p.title || "Untitled",
              blocks: [],
              rev: 0,
            } satisfies ScriptNodeData,
          },
        ];
        edges = [
          ...edges,
          {
            id: `e-${p.nodeId}`,
            source: CHAT_NODE_ID,
            target: p.nodeId,
            animated: true,
            // "ask": anchors to the actual chat bubble that created this node
            // (components/edges/AskEdge.tsx), not a fixed point on the panel.
            type: "ask",
            data: { messageId: p.sourceMessageId, sourcePrompt: p.sourcePrompt },
          },
        ];
      }

      const buf: Buffer = {
        streamId: p.streamId,
        title: p.title,
        content: p.content,
        mode: p.mode,
        blockIndex: p.blockIndex,
        streaming: !p.done,
      };

      // Mid-stream: `nodes` keeps its identity, so no other node re-renders.
      if (!p.done) {
        return { nodes, edges, buffers: { ...s.buffers, [p.nodeId]: buf } };
      }

      return {
        nodes: commit(nodes, p.nodeId, buf),
        edges,
        buffers: { ...s.buffers, [p.nodeId]: buf },
      };
    }),

  toolActivity: [],

  noteToolActivity: (tool, state) =>
    set((s) => {
      const i = s.toolActivity.findIndex((t) => t.tool === tool);
      if (i === -1) return { toolActivity: [...s.toolActivity, { tool, state }] };
      if (s.toolActivity[i].state === state) return s; // no-op, keep the reference
      const next = s.toolActivity.slice();
      next[i] = { tool, state };
      return { toolActivity: next };
    }),

  clearToolActivity: () =>
    set((s) => (s.toolActivity.length === 0 ? s : { toolActivity: [] })),

  commitLocalText: (nodeId, blocks) =>
    set((s) => ({
      nodes: s.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const d = n.data as ScriptNodeData;
        const next = blocks.map((t) => t.trim()).filter(Boolean);
        // Skip no-op writes so idle blur events don't churn the nodes array.
        if (next.join("\n\n") === d.blocks.join("\n\n")) return n;
        return { ...n, data: { ...d, blocks: next } satisfies ScriptNodeData };
      }),
    })),

  settleStreams: () =>
    set((s) => {
      const stuck = Object.entries(s.buffers).filter(([, b]) => b.streaming);
      if (stuck.length === 0) return s;
      let nodes = s.nodes;
      const buffers = { ...s.buffers };
      for (const [nodeId, buf] of stuck) {
        if (buf.content.trim()) nodes = commit(nodes, nodeId, buf);
        buffers[nodeId] = { ...buf, streaming: false };
      }
      return { nodes, buffers };
    }),
}));

// The board starts with just the chat node; everything else is created by use.
export function seedBoard() {
  if (useCanvasStore.getState().nodes.length > 0) return;
  const chat: Node = {
    id: CHAT_NODE_ID,
    type: "chat",
    position: { x: CHAT.x, y: CHAT.y },
    width: CHAT.w,
    height: CHAT.h,
    data: { kind: "chat" } satisfies ChatNodeData,
    draggable: true,
  };
  useCanvasStore.setState({ nodes: [chat] });
}
