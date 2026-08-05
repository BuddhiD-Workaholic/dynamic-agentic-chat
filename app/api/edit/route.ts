import { streamText } from "ai";
import { model } from "@/lib/ai/model";
import { selectionSystem } from "@/lib/ai/prompt";

export const maxDuration = 30;

// Manual, selection-driven edit.
//
// The client already knows exactly which node and which character range to
// change, so this skips intent routing entirely and streams back the
// replacement fragment as plain text. The full script goes in as CONTEXT so the
// rewrite fits its surroundings — but only the fragment comes back, which is
// the whole point of the feature: no whole-document regeneration.
export async function POST(req: Request) {
  const { fullScript, selectedText, instruction } = (await req.json()) as {
    fullScript?: string;
    selectedText?: string;
    instruction?: string;
  };

  if (!selectedText?.trim() || !instruction?.trim()) {
    return new Response("selectedText and instruction are required", {
      status: 400,
    });
  }

  const result = streamText({
    model,
    system: selectionSystem(fullScript ?? selectedText, selectedText),
    prompt: instruction,
  });

  return result.toTextStreamResponse();
}
