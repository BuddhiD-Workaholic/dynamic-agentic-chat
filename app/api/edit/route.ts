import { smoothStream, streamText } from "ai";
import { model } from "@/lib/ai/model";
import { selectionSystem } from "@/lib/ai/prompt";

export const maxDuration = 30;

// The client already knows the node and character range, so this skips intent
// routing and streams back only the replacement fragment as plain text.
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

  // Word-level chunking, same as the chat path: the replacement should visibly
  // build up in place rather than snapping in as one lump.
  const result = streamText({
    model,
    system: selectionSystem(fullScript ?? selectedText, selectedText),
    prompt: instruction,
    experimental_transform: smoothStream({ chunking: "word" }),
  });

  return result.toTextStreamResponse();
}
