import {
  Experimental_Agent as Agent,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  smoothStream,
  stepCountIs,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type UIMessageStreamWriter,
} from "ai";
import { model, routerModel } from "@/lib/ai/model";
import { buildTools, fallbackRouteTool, formatScriptTitle } from "@/lib/ai/tools";
import {
  AGENT_SYSTEM,
  WRITE_SYSTEM,
  boardIndex,
  chatSystem,
  editSystem,
  rewriteSystem,
} from "@/lib/ai/prompt";
import type {
  AppUIMessage,
  BoardScript,
  ScriptStreamPayload,
  UsagePayload,
} from "@/lib/types";

export const maxDuration = 60;

// An agent decides (tools, no prose), then a tool-free call streams the body.
// Phase 2 has no tools attached, so its entire output belongs to one node —
// there is nothing to extract and nothing that can leak into the transcript.
const MAX_STEPS = 6;

export async function POST(req: Request) {
  const { messages, scripts = [] } = (await req.json()) as {
    messages: AppUIMessage[];
    scripts?: BoardScript[];
  };

  // Two views of the same conversation. The type argument is explicit because
  // the signature takes `Omit<UI_MESSAGE, "id">`, which TS can't infer through —
  // left implicit, `part.data` silently widens to `unknown`.

  // ROUTING view: past script turns are converted into "[Wrote the script X…]"
  // markers, so the router doesn't see blank assistant replies.
  const routerMessages: ModelMessage[] = convertToModelMessages<AppUIMessage>(messages, {
    convertDataPart: (part) =>
      part.type === "data-scriptChip"
        ? {
            type: "text",
            text: `[${
              part.data.mode === "write" ? "Wrote" : "Revised"
            } the script "${part.data.title}" in its editor node on the canvas.]`,
          }
        : undefined,
  });

  // WRITING view: deliberately withOUT those markers. The writing call is a
  // tool-free continuation of the conversation, so fed the markers it will
  // imitate them and emit one AS the script body — reproduced from a real
  // session as a node whose entire content was `[Wrote the script "X"…]`.
  const modelMessages: ModelMessage[] = convertToModelMessages<AppUIMessage>(messages);

  const stream = createUIMessageStream<AppUIMessage>({
    onError: (error) => (error instanceof Error ? error.message : String(error)),

    execute: async ({ writer }) => {
      const spent: Spend[] = [];
      const action = await decide(writer, routerMessages, scripts, spent);
      // convertToModelMessages drops the client-assigned id; recovered here so
      // a new node's edge can anchor to the exact bubble that asked for it.
      const sourceMessageId = [...messages].reverse().find((m) => m.role === "user")?.id;
      await act({ action, writer, modelMessages, scripts, spent, sourceMessageId });

      writer.write({ type: "data-usage", id: "usage", data: summarise(spent) });
    },
  });

  return createUIMessageStreamResponse({ stream });
}

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

type Action =
  | { kind: "write"; title: string }
  | { kind: "edit"; nodeId: string; blockIndex: number; instruction: string }
  | { kind: "rewrite"; nodeId: string; instruction: string }
  | { kind: "mindmap"; topic: string; id: string }
  | { kind: "chat" };

async function decide(
  writer: UIMessageStreamWriter<AppUIMessage>,
  messages: ModelMessage[],
  scripts: BoardScript[],
  spent: Spend[],
): Promise<Action> {
  const agent = new Agent({
    model: routerModel,
    system: AGENT_SYSTEM,
    tools: buildTools(scripts),
    stopWhen: stepCountIs(MAX_STEPS),
    // Not a guarantee — some providers return finish_reason:"stop" with prose
    // and no call despite this. The forced-named fallback below covers that.
    toolChoice: "required",
  });

  // stream(), not generate(): routing takes several seconds, so tool calls are
  // reported live rather than as dead air.
  const routed = agent.stream({ messages });

  const note = (tool: string, state: "running" | "done") =>
    writer.write({ type: "data-tool", transient: true, data: { tool, state } });

  // Inspection tools resolve with a result; action tools have no `execute`, so
  // the call itself is where they finish — dedupe by call id covers both.
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

  const chosen = toolCalls
    .filter((c) => !c.dynamic && !c.invalid && c.toolName !== "listEditors")
    .pop();

  log(
    `steps=${(await routed.steps).length} calls=${
      toolCalls.map((c) => c.toolName).join(" -> ") || "(none)"
    }`,
  );

  if (chosen?.toolName === "writeScript")
    return { kind: "write", title: formatScriptTitle(chosen.input) };
  if (chosen?.toolName === "editBlock")
    return {
      kind: "edit",
      nodeId: chosen.input.nodeId,
      blockIndex: chosen.input.blockIndex,
      instruction: chosen.input.instruction,
    };
  if (chosen?.toolName === "rewriteScript")
    return {
      kind: "rewrite",
      nodeId: chosen.input.nodeId,
      instruction: chosen.input.instruction,
    };
  if (chosen?.toolName === "createMindmap")
    return { kind: "mindmap", topic: chosen.input.topic, id: chosen.toolCallId };
  if (chosen) return { kind: "chat" }; // answerInChat

  // No call at all: ask again with a single forced named function, dropping
  // history — a transcript full of prose primes more prose, the failure this
  // recovers from, and classification only needs the latest message anyway.
  const forced = await generateText({
    model: routerModel,
    system: AGENT_SYSTEM,
    prompt: `Classify this request:

"${lastUserText(messages)}"

OPEN EDITORS (ordinals in the request refer to this numbering):
${boardIndex(scripts)}

If the request refers to one of those editors and asks to change, improve, shorten, or fix any part of it, return that editor's exact nodeId. Pick editBlock when one paragraph can be swapped for another and the rest still reads correctly; pick rewriteScript when an item is removed, added, or reordered, or a count changes — anything that leaves the numbering or the intro inconsistent. Changing a script the user already has is never writeScript. Only use answerInChat when the request is not about producing or changing canvas content.`,
    tools: { route: fallbackRouteTool },
    toolChoice: { type: "tool", toolName: "route" },
  });
  spent.push({ label: "fallback", usage: forced.totalUsage });
  const r = forced.toolCalls.find((c) => !c.dynamic && !c.invalid)?.input;
  log(`fallback -> ${r?.action ?? "(still none)"}`);

  if (r?.action === "writeScript")
    return {
      kind: "write",
      title: formatScriptTitle({ title: r.title ?? "Untitled", duration: r.duration, platform: r.platform }),
    };
  if (r?.action === "createMindmap")
    return { kind: "mindmap", topic: r.topic ?? "Untitled", id: crypto.randomUUID() };
  if (r?.action === "editBlock")
    return {
      kind: "edit",
      nodeId: r.nodeId ?? "",
      blockIndex: r.blockIndex ?? 1,
      instruction: r.instruction ?? "Improve this paragraph.",
    };
  if (r?.action === "rewriteScript")
    return {
      kind: "rewrite",
      nodeId: r.nodeId ?? "",
      instruction: r.instruction ?? "Revise this script.",
    };
  return { kind: "chat" };
}

async function act({
  action,
  writer,
  modelMessages,
  scripts,
  spent,
  sourceMessageId,
}: {
  action: Action;
  writer: UIMessageStreamWriter<AppUIMessage>;
  modelMessages: ModelMessage[];
  scripts: BoardScript[];
  spent: Spend[];
  sourceMessageId?: string;
}) {
  const plainChat = async () => {
    const result = streamText({
      model,
      system: chatSystem(scripts),
      messages: modelMessages,
    });
    writer.merge(result.toUIMessageStream());
    spent.push({ label: "chat", usage: await result.totalUsage });
  };

  // Streams one tool-free completion into a single node.
  const pipeInto = async (opts: {
    nodeId: string;
    title: string;
    mode: "write" | "edit" | "rewrite";
    blockIndex?: number;
    system: string;
    prompt?: string;
    // "write" only — anchors the edge to the message that created this node.
    sourceMessageId?: string;
    sourcePrompt?: string;
  }) => {
    const streamId = crypto.randomUUID();

    // Transient: delivered to onData, never added to `messages` — keeps the
    // chat flat while a node streams (measured: otherwise 358 renders/edit).
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
          sourceMessageId: opts.sourceMessageId,
          sourcePrompt: opts.sourcePrompt,
          done,
        } satisfies ScriptStreamPayload,
      });

    // Persistent, written exactly twice: a record in the transcript without
    // the body ever entering it.
    const emitChip = (done: boolean) =>
      writer.write({
        type: "data-scriptChip",
        id: opts.nodeId,
        data: { title: opts.title, mode: opts.mode, done },
      });

    emitChip(false);
    emit("", false); // node appears before the first token

    // Re-chunks to word boundaries — without it a short edit can arrive in
    // 2-3 bursts with a multi-second gap, which reads as the text dropping in
    // whole rather than streaming.
    const result = streamText({
      model,
      system: opts.system,
      experimental_transform: smoothStream({ chunking: "word" }),
      ...(opts.prompt ? { prompt: opts.prompt } : { messages: modelMessages }),
    });

    let acc = "";
    for await (const delta of result.textStream) {
      acc += delta;
      emit(acc, false);
    }
    emit(acc.trim(), true);
    emitChip(true);
    spent.push({ label: opts.mode === "write" ? "writing" : opts.mode, usage: await result.totalUsage });
  };

  if (action.kind === "chat") return plainChat();

  if (action.kind === "mindmap") {
    return writer.write({ type: "data-mindmap", id: action.id, data: { topic: action.topic } });
  }

  if (action.kind === "write") {
    return pipeInto({
      nodeId: `script-${crypto.randomUUID()}`,
      title: action.title,
      mode: "write",
      system: WRITE_SYSTEM,
      sourceMessageId,
      sourcePrompt: lastUserText(modelMessages),
    });
  }

  // Models can hallucinate a nodeId — fall back to the only script on the
  // board when there is exactly one, rather than failing the turn.
  const hit = scripts.find((s) => s.nodeId === action.nodeId);
  const script = hit ?? (scripts.length === 1 ? scripts[0] : undefined);

  // Must NOT fall through to plain chat: an unresolved edit used to land there
  // and the model would regenerate the whole script into the transcript.
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

  if (action.kind === "rewrite") {
    // No `prompt` — this call gets the full conversation instead, so a change
    // requested in an earlier turn ("remove JavaScript") is still visible and
    // doesn't get silently restored by a rewrite that only sees the current text.
    return pipeInto({
      nodeId: script.nodeId,
      title: script.title,
      mode: "rewrite",
      system: rewriteSystem(script.blocks.join("\n\n"), action.instruction),
    });
  }

  const index = Number.isFinite(action.blockIndex) // 1-based, model-supplied
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

// A model-free reply — used where a model call could regenerate a script.
function writeText(writer: UIMessageStreamWriter<AppUIMessage>, text: string) {
  const id = crypto.randomUUID();
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: text });
  writer.write({ type: "text-end", id });
}

function log(msg: string) {
  if (process.env.NODE_ENV !== "production") console.log(`[agent] ${msg}`);
}
