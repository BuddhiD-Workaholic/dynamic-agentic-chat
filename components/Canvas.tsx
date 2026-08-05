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
import { Chat } from "@/components/Chat";

// Chat lives ON the canvas, wired by edges to the scripts it produced — the
// "since it's connected" model from the brief. Kept here rather than in its own
// file to keep the file count down.
const ChatNode = memo(function ChatNode() {
  return (
    <div className="node chat-node">
      <NodeResizer minWidth={320} minHeight={320} lineClassName="rf-resize-line" handleClassName="rf-resize-handle" />
      <Chat />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

// Module scope, deliberately. An inline object would be a new reference on
// every render and React Flow remounts every node when nodeTypes changes —
// the classic footgun that would wreck the isolation this POC is measuring.
const nodeTypes = { script: ScriptNode, chat: ChatNode };

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
