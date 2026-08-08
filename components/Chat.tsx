"use client";

import { memo, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCanvasStore } from "@/lib/store";
import { routeScriptData, useSettleStreams } from "@/components/useScriptRouter";
import { RenderBadge } from "@/components/RenderBadge";
import type { AppUIMessage } from "@/lib/types";

// Tool names are internal implementation detail — the person watching this
// strip is asking "what is it doing", not "which function is running".
const TOOL_LABEL: Record<string, string> = {
  listEditors: "Looking at your scripts",
  writeScript: "Writing a new script",
  editBlock: "Editing a paragraph",
  rewriteScript: "Rewriting the script",
  createMindmap: "Building a mindmap",
  answerInChat: "Thinking",
};

// Own component so tool events (several per turn) re-render this strip only,
// not the whole transcript.
const AgentActivity = memo(function AgentActivity() {
  const activity = useCanvasStore((s) => s.toolActivity);
  if (activity.length === 0) return null;
  return (
    <div className="agent-activity">
      {activity.map((a) => (
        <div key={a.tool} className={`tool-line ${a.state}`}>
          <span className="tool-dot" />
          <span>{TOOL_LABEL[a.tool] ?? a.tool}</span>
          {a.state === "running" && <span className="tool-state">…</span>}
        </div>
      ))}
    </div>
  );
});

const nf = new Intl.NumberFormat("en-US");

// Split out and memoised on `messages` — `Chat` re-renders on every keystroke,
// and without this split that re-ran the whole messages.map() each time.
const ChatLog = memo(function ChatLog({
  messages,
  error,
}: {
  messages: AppUIMessage[];
  error?: Error;
}) {
  const logRef = useRef<HTMLDivElement>(null);

  // Stick to the bottom until the user deliberately scrolls away, rather than
  // re-deciding from the current distance on every message — the agent-activity
  // strip appearing below the log is a container RESIZE, not a message change,
  // so a messages-only effect can miss it.
  const stick = useRef(true);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;

    const toBottom = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };

    // Synchronous first, so following doesn't depend on a frame callback —
    // rAF and ResizeObserver are both suspended in a hidden tab. The rAF pass
    // then corrects for anything landing later in the same commit.
    toBottom();
    const frame = requestAnimationFrame(toBottom);
    const ro = new ResizeObserver(toBottom); // catches the resize `messages` can't see
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [messages]);

  return (
    <div className="chat-log nowheel nodrag" ref={logRef} onScroll={onScroll}>
      <RenderBadge label="log" className="render-badge log-badge" />
        {messages.length === 0 && (
          <div className="empty">
            <p>Try, in order:</p>
            <ol>
              <li>“Write a 30-second TikTok script explaining Minecraft.”</li>
              <li>“Improve the middle paragraph of the Minecraft script.”</li>
              <li>“What are apples?” — stays in chat, no node</li>
              <li>“Make a mindmap of video ideas.” — different tool</li>
            </ol>
            <p>Then select a phrase inside a script node and edit it.</p>
          </div>
        )}

        {messages.map((m) => (
          // data-message-id: how a node's edge finds the bubble that asked for it.
          <div key={m.id} data-message-id={m.id} className={`msg ${m.role}`}>
            {m.parts.map((part, i) => {
              if (part.type === "text")
                return (
                  <span key={i} className="msg-text">
                    {part.text}
                  </span>
                );

              if (part.type === "data-scriptChip")
                return (
                  <div key={i} className="chip">
                    📝{" "}
                    {part.data.mode === "write"
                      ? "Writing"
                      : part.data.mode === "rewrite"
                        ? "Rewriting"
                        : "Revising"}{" "}
                    →{" "}
                    “{part.data.title || "script"}”
                    {part.data.done ? " ✓" : " …"}
                  </div>
                );

              if (part.type === "data-usage")
                return (
                  <div key={i} className="usage" title="Route-then-stream costs more than one model call; this is the breakdown.">
                    {nf.format(part.data.totalTokens)} tokens
                    <span className="usage-detail">
                      {" "}(in {nf.format(part.data.inputTokens)} · out{" "}
                      {nf.format(part.data.outputTokens)}
                      {part.data.calls.length > 1
                        ? ` · ${part.data.calls.map((c) => `${c.label} ${nf.format(c.totalTokens)}`).join(", ")}`
                        : ""}
                      )
                    </span>
                  </div>
                );

              if (part.type === "data-mindmap")
                return (
                  <div key={i} className="chip">
                    🧠 Mindmap (different tool) → {part.data.topic}
                  </div>
                );

              return null;
            })}
          </div>
        ))}

      {error && <div className="chat-error">⚠ {error.message}</div>}
    </div>
  );
});

export function Chat() {
  const [input, setInput] = useState("");

  // Off by default — debug info for whoever is developing this, not for a
  // person writing a script. Hidden in CSS, not unmounted, so counts keep
  // accruing and are already correct the moment this is switched on.
  const [showDebugInfo, setShowDebugInfo] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.renders = showDebugInfo ? "on" : "off";
  }, [showDebugInfo]);

  const { messages, sendMessage, status, error } = useChat<AppUIMessage>({
    onData: routeScriptData, // transient script content arrives here, not via `messages`
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // A fresh board snapshot each turn lets the model resolve "the Minecraft script".
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages, scripts: useCanvasStore.getState().getBoardScripts() },
      }),
    }),
  });

  useSettleStreams(status);

  // "submitted" is a live status too — guarding only on "streaming" lets a
  // double Enter fire two requests.
  const sending = status === "submitted" || status === "streaming";

  const send = () => {
    if (!input.trim() || sending) return;
    sendMessage({ text: input });
    setInput("");
  };

  return (
    <div className="chat">
      <div className="chat-header">
        <strong>Chat</strong>
        <span className="muted">scripts stream to their own nodes →</span>
        <button
          className="renders-toggle nodrag"
          aria-pressed={showDebugInfo}
          aria-label="Toggle debug info"
          onClick={() => setShowDebugInfo((v) => !v)}
          title="Show debug info: render counters and token cost"
        >
          🛠
        </button>
        <RenderBadge label="renders" />
      </div>

      <ChatLog messages={messages} error={error} />

      <AgentActivity />

      <div className="chat-input nodrag">
        <textarea
          rows={2}
          value={input}
          placeholder="Ask for a script…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={sending || !input.trim()}>
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
