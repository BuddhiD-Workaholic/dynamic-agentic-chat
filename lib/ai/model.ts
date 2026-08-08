import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// `@ai-sdk/openai-compatible`, not `@ai-sdk/openai` — the official provider
// defaults to the Responses API, which third-party endpoints don't serve.
const provider = createOpenAICompatible({
  name: "openai-compatible",
  baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY ?? "",
  includeUsage: true, // without this, streaming responses report zero tokens
});

const MODEL = process.env.MODEL ?? "gpt-4o";

// Reasoning models on OpenAI-compatible endpoints emit their chain of thought
// inline in `content`, wrapped in <think>...</think>, instead of a separate
// field. This peels those blocks into reasoning parts so `textStream` stays
// pure body text; a no-op on models that don't emit the tags.
const withReasoningStripped = (modelId: string) =>
  wrapLanguageModel({
    model: provider.chatModel(modelId),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });

export const model = withReasoningStripped(MODEL);

// Routing only needs a few dozen tokens of output, so a smaller/faster model
// works well here — set ROUTER_MODEL to use one.
export const routerModel = withReasoningStripped(
  process.env.ROUTER_MODEL ?? MODEL,
);
