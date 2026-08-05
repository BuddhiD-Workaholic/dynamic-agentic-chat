import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Plain Chat Completions against any OpenAI-compatible endpoint.
//
// Note this is `@ai-sdk/openai-compatible`, NOT `@ai-sdk/openai`. In AI SDK 5
// the official OpenAI provider defaults to the *Responses* API, which
// third-party endpoints (MiniMax, Together, Groq, vLLM...) do not serve. Going
// through the compatible provider means the same code runs against MiniMax
// locally and against PoppyAI's real OpenAI key in production — only env vars
// change.
const provider = createOpenAICompatible({
  name: "openai-compatible",
  baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "",
  // Sends stream_options.include_usage. Without it a STREAMING response carries
  // no usage chunk at all, so every streamed call reports zero tokens while
  // non-streamed ones report correctly — which is exactly what the first
  // measurement showed.
  includeUsage: true,
});

const MODEL = process.env.MODEL ?? "gpt-4o";

// Reasoning models on OpenAI-compatible endpoints emit their chain of thought
// INLINE in `content`, wrapped in <think>...</think>, rather than in a separate
// field. Measured on MiniMax-M3: the first 80 characters of a "write me a
// script" response are the model thinking out loud about TikTok pacing.
//
// Unwrapped, that monologue streams straight into the script node — the node
// fills with reasoning instead of the script. This middleware peels <think>
// blocks off into reasoning parts, leaving `textStream` as pure body text.
// Harmless on non-reasoning models like gpt-4o, which simply emit no such tags.
const withReasoningStripped = (modelId: string) =>
  wrapLanguageModel({
    model: provider.chatModel(modelId),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });

// Writes the actual prose.
export const model = withReasoningStripped(MODEL);

// Decides intent only. Its output is a few dozen tokens, so a smaller/faster
// model is usually fine here and shaves latency off the round trip that
// happens before any text appears. Measured cost of this hop on MiniMax-M3:
// ~2.0s, against ~1.0s to first body token.
export const routerModel = withReasoningStripped(
  process.env.ROUTER_MODEL ?? MODEL,
);
