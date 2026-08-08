"use client";

import { useEffect, useState } from "react";
import { BaseEdge, getBezierPath, Position, useReactFlow, type EdgeProps } from "@xyflow/react";

type AskEdgeData = { messageId?: string; sourcePrompt?: string };

// Anchors the edge's SOURCE end to the live screen position of the chat
// bubble that created this node, so with several scripts on the board it's
// obvious which ask produced which. The target side is left to React Flow.
export function AskEdge({
  id,
  targetX,
  targetY,
  targetPosition,
  data,
  style,
  markerEnd,
}: EdgeProps) {
  const { messageId, sourcePrompt } = (data ?? {}) as AskEdgeData;
  const { screenToFlowPosition } = useReactFlow();

  // No re-render on canvas pan/zoom — once converted to flow coordinates, a
  // point pans and zooms for free via the ancestor CSS transform. What it
  // can't track for free is the chat log's own scroll or resize, since those
  // move the bubble on screen without moving anything in flow space.
  const [, recompute] = useState(0);
  useEffect(() => {
    if (!messageId) return;
    const bump = () => recompute((n) => n + 1);
    const log = document.querySelector(".chat-log");
    log?.addEventListener("scroll", bump, { passive: true });
    const ro = new ResizeObserver(bump);
    if (log) ro.observe(log);
    bump(); // first measurement must happen post-mount, not mid-render
    return () => {
      log?.removeEventListener("scroll", bump);
      ro.disconnect();
    };
  }, [messageId]);

  let sourceX = targetX - 200;
  let sourceY = targetY;

  if (messageId) {
    const bubble = document.querySelector(`[data-message-id="${messageId}"]`);
    const log = document.querySelector(".chat-log");
    if (bubble && log) {
      const bubbleRect = bubble.getBoundingClientRect();
      const logRect = log.getBoundingClientRect();
      // Clamp to the nearest visible edge if the bubble has scrolled off.
      const clampedY = Math.min(
        Math.max(bubbleRect.top + bubbleRect.height / 2, logRect.top + 8),
        logRect.bottom - 8,
      );
      const flow = screenToFlowPosition({ x: bubbleRect.right, y: clampedY });
      sourceX = flow.x;
      sourceY = flow.y;
    }
  }

  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {sourcePrompt && (
        // Native tooltip, invisible until hover.
        <path d={path} fill="none" stroke="transparent" strokeWidth={16}>
          <title>{sourcePrompt}</title>
        </path>
      )}
    </>
  );
}
