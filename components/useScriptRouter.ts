import { useEffect } from "react";
import type { DataUIPart } from "ai";
import { useCanvasStore } from "@/lib/store";
import type { AppDataTypes } from "@/lib/types";

// The stream-isolation seam on the client.
//
// Script content and tool activity arrive as TRANSIENT data parts, which the SDK
// hands to this callback and never adds to `messages`. That is the whole point:
// scanning `messages` meant the chat re-rendered on every token (measured at 358
// renders for one paragraph edit), because each token mutated the message list.
//
// Not a hook, so it can be passed straight to useChat's onData without the
// circular dependency of needing `status` before useChat has returned it.
export function routeScriptData(part: DataUIPart<AppDataTypes>) {
  const store = useCanvasStore.getState();
  if (part.type === "data-script") store.applyScript(part.data);
  else if (part.type === "data-tool") store.noteToolActivity(part.data.tool, part.data.state);
}

// Two jobs, both keyed off the chat status.
//
// A dropped or failed stream would otherwise leave a node pinned in its
// read-only streaming view forever — no editor, no recovery short of a reload.
// And tool activity is per-turn status, so it clears when the next turn starts.
export function useSettleStreams(status: string) {
  useEffect(() => {
    const store = useCanvasStore.getState();
    if (status === "submitted") store.clearToolActivity();
    if (status === "error" || status === "ready") store.settleStreams();
  }, [status]);
}
