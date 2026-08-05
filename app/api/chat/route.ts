import {
  Experimental_Agent as Agent,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import { model, routerModel } from "@/lib/ai/model";
import { buildTools, fallbackRouteTool } from "@/lib/ai/tools";
import {
  AGENT_SYSTEM,
  CHAT_SYSTEM,
  WRITE_SYSTEM,
  boardIndex,
  editSystem,
} from "@/lib/ai/prompt";
import type {
  AppUIMessage,
  BoardScript,
  ScriptStreamPayload,
  UsagePayload,
} from "@/lib/types";

export const maxDuration = 60;

// An agent decides, then a tool-free call writes.
//
// Phase 1 is an agent with tools but no prose: it inspects the board through
// listEditors and commits to one action. Every tool argument is short, so it
// does not matter that this provider streams tool arguments unevenly.
//
// Phase 2 streams the body with NO tools attached. That is the isolation
// guarantee, and it is structural rather than a parsing trick: the entire
// output of that call belongs to exactly one node, so there is nothing to
// extract and nothing that *can* leak into the transcript. Measured against the
// alternative (body inside the tool argument), that alternative leaked prose
// into chat and once delivered 1511 characters in a single chunk. See README.
const MAX_STEPS = 6;

export async function POST(req: Request) {
  const { messages, scripts = [] } = (await req.json()) as {
    messages: AppUIMessage[];
    scripts?: BoardScript[];
  };

  const modelMessages: ModelMessage[] = convertToModelMessages(messages);

  const stream = createUIMessageStream<AppUIMessage>({
    // Default masks errors as "An error occurred." A wrong model id or base URL
    // is the likeliest failure and is otherwise invisible from the UI.
    onError: (error) => (error instanceof Error ? error.message : String(error)),

    execute: async ({ writer }) => {
      const spent: Spend[] = [];
      const action = await decide(writer, modelMessages, scripts, spent);
      await act({ action, writer, modelMessages, scripts, spent });

      // Written once, at the very end. Route-then-stream costs more than one
      // model call, and the breakdown makes that visible rather than hidden.
      writer.write({ type: "data-usage", id: "usage", data: summarise(spent) });
    },
  });

  return createUIMessageStreamResponse({ stream });
}

// One model call's cost, labelled so the breakdown means something.
type Spend = { label: string; usage: LanguageModelUsage | undefined };

function summarise(spent: Spend[]): UsagePayload {
  const n = (v: number | undefined) => v ?? 0;
  return {
    totalTokens: spent.reduce((a, c) => a + n(c.usage?.totalTokens), 0),
    inputTokens: spent.reduce((a, c) => a + n(c.usage?.inputTokens), 0),
    outputTokens: spent.reduce((a, c) => a + n(c.usage?.outputTokens), 0),
    reasoningTokens: spent.reduce((a, c) => a + n(c.usage?.reasoningTokens), 0),
    calls: spent.map((c) => ({ label: c.label, totalTokens: n(c.usage?.totalTokens) })),
  };
}

// What the agent settled on. One shape, so the primary path and the fallback
// converge instead of leaving two tool-call unions to switch over.
type Action =
  | { kind: "write"; title: string }
  | { kind: "edit"; nodeId: string; blockIndex: number; instruction: string }
  | { kind: "mindmap"; topic: string; id: string }
  | { kind: "chat" };

async function decide(
  writer: UIMessageStreamWriter<AppUIMessage>,
  messages: ModelMessage[],
  scripts: BoardScript[],
  spent: Spend[],
): Promise<Action> {
  // Built per request because listEditors closes over this board.
  const agent = new Agent({
    model: routerModel,
    system: AGENT_SYSTEM,
    tools: buildTools(scripts),
    stopWhen: stepCountIs(MAX_STEPS),
    // Paired with the answerInChat tool, so "just reply" is something the agent
    // names rather than the absence of a call.
    //
    // A nudge, NOT a guarantee: measured on MiniMax-M3 this is honoured only
    // sometimes — the provider returns finish_reason:"stop" with prose and no
    // call at all. Hence the forced-named fallback below. On providers that do
    // honour it (OpenAI), this layer alone is enough.
    toolChoice: "required",
  });

  // stream() rather than generate(): routing takes several seconds and used to
  // be dead air. Streaming lets the tool calls be reported as they happen.
  const routed = agent.stream({ messages });

  // TRANSIENT — live status, not conversation. Goes to onData, never `messages`.
  const note = (tool: string, state: "running" | "done") =>
    writer.write({ type: "data-tool", transient: true, data: { tool, state } });

  // Inspection tools resolve with a result; action tools have no `execute`, so
  // the call itself is where they finish. Tools that DO execute emit both, hence
  // the dedupe by call id.
  const settled = new Set<string>();
  for await (const part of routed.fullStream) {
    if (part.type === "tool-input-start") {
      note(part.toolName, "running");
    } else if (part.type === "tool-call" || part.type === "tool-result") {
      if (settled.has(part.toolCallId)) continue;
      settled.add(part.toolCallId);
      note(part.toolName, "done");
    }
  }

  const toolCalls = await routed.toolCalls;
  spent.push({ label: "routing", usage: await routed.totalUsage });

  // toolCalls aggregates every step, so drop the inspection calls and take the
  // action it settled on. The dynamic variant (an unparsable call, or a tool the
  // model invented) types `input` as unknown — discarding it gives real types
  // and degrades garbage to chat.
  const chosen = toolCalls
    .filter((c) => !c.dynamic && !c.invalid && c.toolName !== "listEditors")
    .pop();

  log(
    `steps=${(await routed.steps).length} calls=${
      toolCalls.map((c) => c.toolName).join(" -> ") || "(none)"
    }`,
  );

  if (chosen?.toolName === "writeScript")
    return { kind: "write", title: chosen.input.title };
  if (chosen?.toolName === "editBlock")
    return {
      kind: "edit",
      nodeId: chosen.input.nodeId,
      blockIndex: chosen.input.blockIndex,
      instruction: chosen.input.instruction,
    };
  if (chosen?.toolName === "createMindmap")
    return { kind: "mindmap", topic: chosen.input.topic, id: chosen.toolCallId };
  if (chosen) return { kind: "chat" }; // answerInChat

  // No call at all: the provider ignored toolChoice and answered in prose. Ask
  // again with a single FORCED named function, which it honours far more often.
  //
  // Deliberately WITHOUT the conversation history. Measured: forcing works 3/3
  // on a bare request but degrades on a long transcript — a history full of
  // prose primes yet more prose, which is the very failure being recovered from.
  // Classification only needs the latest ask, and dropping the rest also makes
  // this call O(1) in conversation length.
  const forced = await generateText({
    model: routerModel,
    system: AGENT_SYSTEM,
    prompt: `Classify this request:

"${lastUserText(messages)}"

OPEN EDITORS (ordinals in the request refer to this numbering):
${boardIndex(scripts)}

If the request refers to one of those editors and asks to change, improve, rewrite, shorten, or fix any part of it, the action is editBlock and you must return that editor's exact nodeId. Only use answerInChat when the request is not about producing or changing canvas content.`,
    tools: { route: fallbackRouteTool },
    toolChoice: { type: "tool", toolName: "route" },
  });
  spent.push({ label: "fallback", usage: forced.totalUsage });
  const r = forced.toolCalls.find((c) => !c.dynamic && !c.invalid)?.input;
  log(`fallback -> ${r?.action ?? "(still none)"}`);

  if (r?.action === "writeScript")
    return { kind: "write", title: r.title ?? "Untitled" };
  if (r?.action === "createMindmap")
    return {
      kind: "mindmap",
      topic: r.topic ?? "Untitled",
      id: crypto.randomUUID(),
    };
  if (r?.action === "editBlock")
    return {
      kind: "edit",
      nodeId: r.nodeId ?? "",
      blockIndex: r.blockIndex ?? 1,
      instruction: r.instruction ?? "Improve this paragraph.",
    };
  return { kind: "chat" };
}

async function act({
  action,
  writer,
  modelMessages,
  scripts,
  spent,
}: {
  action: Action;
  writer: UIMessageStreamWriter<AppUIMessage>;
  modelMessages: ModelMessage[];
  scripts: BoardScript[];
  spent: Spend[];
}) {
  const plainChat = async () => {
    const result = streamText({
      model,
      system: CHAT_SYSTEM,
      messages: modelMessages,
    });
    writer.merge(result.toUIMessageStream());
    spent.push({ label: "chat", usage: await result.totalUsage });
  };

  // Streams one tool-free completion into a single node.
  const pipeInto = async (opts: {
    nodeId: string;
    title: string;
    mode: "write" | "edit";
    blockIndex?: number;
    system: string;
    prompt?: string;
  }) => {
    const streamId = crypto.randomUUID();

    // TRANSIENT: delivered to useChat's onData and never added to `messages`.
    // As a normal data part every token mutated the message list, so the chat
    // node re-rendered once per token (measured: 358 renders for one paragraph
    // edit). This is what keeps the chat flat while a node streams.
    const emit = (content: string, done: boolean) =>
      writer.write({
        type: "data-script",
        transient: true,
        data: {
          nodeId: opts.nodeId,
          streamId,
          title: opts.title,
          content,
          mode: opts.mode,
          blockIndex: opts.blockIndex,
          done,
        } satisfies ScriptStreamPayload,
      });

    // PERSISTENT, and written exactly twice: the transcript keeps a record that
    // a script was written, without the body ever entering it. Same id both
    // times, so the SDK reconciles rather than appending.
    const emitChip = (done: boolean) =>
      writer.write({
        type: "data-scriptChip",
        id: opts.nodeId,
        data: { title: opts.title, mode: opts.mode, done },
      });

    emitChip(false);
    emit("", false); // node appears before the first token

    const result = streamText({
      model,
      system: opts.system,
      ...(opts.prompt ? { prompt: opts.prompt } : { messages: modelMessages }),
    });

    let acc = "";
    for await (const delta of result.textStream) {
      acc += delta;
      emit(acc, false);
    }
    emit(acc.trim(), true);
    emitChip(true);
    spent.push({ label: opts.mode === "edit" ? "edit" : "writing", usage: await result.totalUsage });
  };

  if (action.kind === "chat") return plainChat();

  if (action.kind === "mindmap") {
    return writer.write({
      type: "data-mindmap",
      id: action.id,
      data: { topic: action.topic },
    });
  }

  if (action.kind === "write") {
    return pipeInto({
      nodeId: `script-${crypto.randomUUID()}`,
      title: action.title,
      mode: "write",
      system: WRITE_SYSTEM,
    });
  }

  // Models can hallucinate a nodeId. Fall back to the only script on the board
  // when there is exactly one, rather than failing the turn.
  const hit = scripts.find((s) => s.nodeId === action.nodeId);
  const script = hit ?? (scripts.length === 1 ? scripts[0] : undefined);

  // An unresolvable edit must NOT fall through to a chat completion.
  //
  // It used to. With three same-titled scripts on the board, "change the second
  // paragraph of the 2nd script" resolved to nothing, hit plainChat(), and the
  // model happily regenerated the entire script into the transcript —
  // reproduced 5/5, and the exact failure this whole feature exists to prevent.
  // Asking deterministically is always better than guessing which script to
  // rewrite, and unlike a model call it cannot produce a script at all.
  if (!script || script.blocks.length === 0) {
    return writeText(
      writer,
      scripts.length === 0
        ? "There are no script editors open yet — ask me to write one first."
        : `I couldn't tell which script you meant. Open editors:\n${scripts
            .map((s, i) => `${i + 1}. ${s.title} (${s.blocks.length} paragraphs)`)
            .join("\n")}\n\nTell me the number, e.g. "change paragraph 2 of script 1".`,
    );
  }

  // blockIndex is 1-based and model-supplied.
  const index = Number.isFinite(action.blockIndex)
    ? Math.min(Math.max(action.blockIndex - 1, 0), script.blocks.length - 1)
    : 0;

  return pipeInto({
    nodeId: script.nodeId,
    title: script.title,
    mode: "edit",
    blockIndex: index,
    system: editSystem(script.blocks.join("\n\n"), script.blocks[index]),
    prompt: action.instruction,
  });
}

function lastUserText(messages: ModelMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return last.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

// A fixed message we author, streamed as ordinary chat text. Used where a model
// call would be dangerous — it cannot regenerate a script, because there is no
// model involved.
function writeText(writer: UIMessageStreamWriter<AppUIMessage>, text: string) {
  const id = crypto.randomUUID();
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: text });
  writer.write({ type: "text-end", id });
}

// Routing decisions are invisible from the UI and the first thing you want to
// see when gating misbehaves.
function log(msg: string) {
  if (process.env.NODE_ENV !== "production") console.log(`[agent] ${msg}`);
}
