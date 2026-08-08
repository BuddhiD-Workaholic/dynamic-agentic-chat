"use client";

import { memo, useEffect } from "react";
import {
  Background,
  Controls,
  Handle,
  NodeResizer,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { seedBoard, useCanvasStore } from "@/lib/store";
import { ScriptNode } from "@/components/nodes/ScriptNode";
import { AskEdge } from "@/components/edges/AskEdge";
import { Chat } from "@/components/Chat";

// Chat lives ON the canvas, wired by edges to the scripts it produced.
const ChatNode = memo(function ChatNode() {
  return (
    <div className="node chat-node">
      <NodeResizer minWidth={320} minHeight={320} lineClassName="rf-resize-line" handleClassName="rf-resize-handle" />
      <Chat />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

// Module scope: an inline object here would be a new reference every render,
// and React Flow remounts every node when nodeTypes changes.
const nodeTypes = { script: ScriptNode, chat: ChatNode };
const edgeTypes = { ask: AskEdge };

export function Canvas() {
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);

  useEffect(() => seedBoard(), []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      minZoom={0.2}
      maxZoom={1.5}
      defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
