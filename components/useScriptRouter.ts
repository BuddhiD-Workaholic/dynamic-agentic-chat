import { useEffect } from "react";
import type { DataUIPart } from "ai";
import { useCanvasStore } from "@/lib/store";
import type { AppDataTypes } from "@/lib/types";

// Script content and tool activity arrive as TRANSIENT data parts, handed to
// this callback and never added to `messages` — scanning `messages` meant the
// chat re-rendered on every token.
//
// Not a hook, so it can pass straight to useChat's onData without needing
// `status` before useChat has returned it.
export function routeScriptData(part: DataUIPart<AppDataTypes>) {
  const store = useCanvasStore.getState();
  if (part.type === "data-script") store.applyScript(part.data);
  else if (part.type === "data-tool") store.noteToolActivity(part.data.tool, part.data.state);
}

// A dropped or failed stream would otherwise leave a node pinned in its
// read-only streaming view forever, with no recovery short of a reload.
export function useSettleStreams(status: string) {
  useEffect(() => {
    const store = useCanvasStore.getState();
    if (status === "submitted") store.clearToolActivity();
    if (status === "error" || status === "ready") store.settleStreams();
  }, [status]);
}
