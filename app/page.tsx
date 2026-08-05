"use client";

import { ReactFlowProvider } from "@xyflow/react";
import { Canvas } from "@/components/Canvas";

// The whole app is the board. Chat is a node on it, not a side panel.
export default function Page() {
  return (
    <ReactFlowProvider>
      <main className="board">
        <Canvas />
      </main>
    </ReactFlowProvider>
  );
}
