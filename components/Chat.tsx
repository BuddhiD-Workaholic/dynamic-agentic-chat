"use client";

import { memo, useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCanvasStore } from "@/lib/store";
import { routeScriptData, useSettleStreams } from "@/components/useScriptRouter";
import { RenderBadge } from "@/components/RenderBadge";
import type { AppUIMessage } from "@/lib/types";

// Live agent activity, in its own component with its own store subscription.
//
// Placed here rather than inside ChatLog on purpose: tool events fire several
// times per turn, and routing them through the transcript would re-render every
// message. This way a tool event re-renders exactly this strip.
const AgentActivity = memo(function AgentActivity() {
  const activity = useCanvasStore((s) => s.toolActivity);
  if (activity.length === 0) return null;
  return (
    <div className="agent-activity">
      {activity.map((a) => (
        <div key={a.tool} className={`tool-line ${a.state}`}>
          <span className="tool-dot" />
          <code>{a.tool}</code>
          <span className="tool-state">{a.state === "running" ? "running…" : "done"}</span>
        </div>
      ))}
    </div>
  );
});

const nf = new Intl.NumberFormat("en-US");

// The transcript, split out and memoised.
//
// `Chat` owns the textarea's value and useChat's status, so it re-renders on
// every keystroke and every status change. Without this split those re-renders
// re-ran the whole messages.map() — typing one character re-rendered the entire
// transcript. Memoised on `messages`, the log now renders only when the
// conversation actually changes: twice per script turn, for the two chip writes.
const ChatLog = memo(function ChatLog({
  messages,
  error,
}: {
  messages: AppUIMessage[];
  error?: Error;
}) {
  return (
    <div className="chat-log nowheel nodrag">
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
          <div key={m.id} className={`msg ${m.role}`}>
            {m.parts.map((part, i) => {
              // Only text renders in the transcript. The script body arrives as
              // a data part, so it cannot leak in here even by accident.
              if (part.type === "text")
                return (
                  <span key={i} className="msg-text">
                    {part.text}
                  </span>
                );

              // The chip is a small persistent record. The script body itself
              // is transient and never reaches `messages`, so it cannot leak
              // into the transcript even by accident.
              if (part.type === "data-scriptChip")
                return (
                  <div key={i} className="chip">
                    📝 {part.data.mode === "edit" ? "Revising" : "Writing"} →{" "}
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

  // Paragraph render counters are instrumentation, so they are off by default —
  // inline numbers make the script itself hard to read. Driven through a data
  // attribute and hidden in CSS rather than by unmounting the badges, so the
  // counts keep accruing while hidden and are correct the moment you toggle
  // them on mid-stream.
  const [showParaRenders, setShowParaRenders] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.renders = showParaRenders ? "on" : "off";
  }, [showParaRenders]);

  const { messages, sendMessage, status, error } = useChat<AppUIMessage>({
    // Script content is transient, so it never lands in `messages`; it arrives
    // here instead. That is what keeps this component's render count flat while
    // a script node streams.
    onData: routeScriptData,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // A fresh snapshot of the board every turn is what lets the model resolve
      // "the Minecraft script" to a specific node.
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
          aria-pressed={showParaRenders}
          onClick={() => setShowParaRenders((v) => !v)}
          title="Show per-paragraph render counters. During an edit, only the paragraph being changed should move."
        >
          ¶
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
