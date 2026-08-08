import { tool } from "ai";
import { z } from "zod";
import type { BoardScript } from "@/lib/types";

// The agent discovers the board through this tool. Nothing about the canvas is
// injected into the prompt.
function listEditors(scripts: BoardScript[]) {
  return tool({
    description:
      "See the script editors open on the canvas. Call with no arguments to list them. Call with a nodeId to read that script's numbered paragraphs in full — do this before editBlock so the paragraph number you cite is correct.",
    inputSchema: z.object({
      nodeId: z
        .string()
        .optional()
        .describe("Omit to list all open editors; provide to read one in full."),
    }),
    execute: async ({ nodeId }) => {
      if (!nodeId) {
        return {
          editors: scripts.map((s, i) => ({
            nodeId: s.nodeId,
            title: s.title,
            paragraphs: s.blocks.length,
            createdOrder: i + 1,
            // Stated explicitly: "the one you just wrote" is otherwise an
            // ordering the model would have to guess at.
            mostRecent: i === scripts.length - 1,
          })),
        };
      }
      const s = scripts.find((x) => x.nodeId === nodeId);
      if (!s) {
        return {
          error: `No open editor with nodeId "${nodeId}".`,
          availableNodeIds: scripts.map((x) => x.nodeId),
        };
      }
      return {
        nodeId: s.nodeId,
        title: s.title,
        paragraphs: s.blocks.map((text, i) => ({ number: i + 1, text })),
      };
    },
  });
}

// The actions. None carries prose: each names what to do, and a second,
// tool-free call streams the body into the node it named. That keeps every
// argument short, so it does not matter whether the provider streams tool
// arguments smoothly — measured, this one does not always.
export const buildTools = (scripts: BoardScript[]) => ({
  listEditors: listEditors(scripts),

  writeScript: tool({
    description:
      "Create a NEW script or long-form draft (YouTube/TikTok script, LinkedIn/X post, blog draft, cold email) as its own node on the canvas. Use ONLY for reusable long-form content the user will iterate on. Do NOT use for short answers, explanations, or general knowledge questions.",
    inputSchema: z.object({
      title: z.string().describe('Short label, e.g. "Minecraft explainer".'),
    }),
  }),

  editBlock: tool({
    description:
      'Revise ONE paragraph of an EXISTING script, in place, without regenerating the whole script. Use when the user asks to change part of a script they already have (e.g. "improve the middle paragraph of the Minecraft script"). Get nodeId and the paragraph number from listEditors first.',
    inputSchema: z.object({
      nodeId: z.string().describe("Id of the existing script node."),
      blockIndex: z.number().int().min(1).describe("1-based paragraph number."),
      instruction: z
        .string()
        .describe('What to change, e.g. "make it punchier".'),
    }),
  }),

  // The action that was missing, and the reason a "remove Java from the top 5"
  // request used to land on writeScript: editBlock swaps one paragraph for one
  // paragraph, so it cannot delete an item, insert one, or renumber the ones
  // around it. Faced with a request needing any of that, the only tool whose
  // EFFECT matched was writeScript — which spawns a second node. This one
  // restructures in place, keeping the same nodeId.
  rewriteScript: tool({
    description:
      'Replace an EXISTING script with a fully revised version, IN PLACE, keeping the same node. Use whenever the change cannot be contained inside a single paragraph: removing an item from a list, adding one, reordering, changing the count ("make it a top 3"), or any edit that would leave the numbering, intro, or outro inconsistent. Examples: "remove Java from the top 5", "add Swift as well", "cut the last tip". This creates NO new node — never use writeScript to iterate on a script the user already has. Only for requests that change the script itself: a question ABOUT a script ("summarise it", "what does it say") is answerInChat. Get nodeId from listEditors first.',
    inputSchema: z.object({
      nodeId: z.string().describe("Id of the existing script node to replace."),
      instruction: z
        .string()
        .describe(
          'The whole change to make, e.g. "remove Java and renumber the remaining four".',
        ),
    }),
  }),

  createMindmap: tool({
    description:
      "Create a mindmap (NOT a script). Use for mindmap/diagram requests. Stub in this POC — it exists to prove a non-script intent routes somewhere else instead of tripping the script path.",
    inputSchema: z.object({
      topic: z.string().describe("What the mindmap is about."),
    }),
  }),

  // Makes "just reply in the chat" a choice the agent can name, rather than the
  // absence of one. Turns "did it remember to call a tool?" into "which tool?",
  // which is a strictly easier question.
  answerInChat: tool({
    description:
      "Reply to the user in the chat transcript, creating nothing on the canvas. Use for questions, greetings, factual lookups, clarifications — anything that is not reusable long-form content.",
    inputSchema: z.object({}),
  }),
});

// Last resort, used only when the agent returns no tool call at all.
//
// Measured on MiniMax-M3: toolChoice:"required" is honoured only sometimes — the
// provider will return finish_reason:"stop" with ~1400 characters of prose and
// no call. That is exactly how a script ends up in the chat transcript. Forcing
// a NAMED function is respected far more consistently (3/3 on script requests),
// so the fallback collapses every action into one tool with an enum.
export const fallbackRouteTool = tool({
  description: "Classify what the user is asking for.",
  inputSchema: z.object({
    action: z
      .enum([
        "writeScript",
        "editBlock",
        "rewriteScript",
        "createMindmap",
        "answerInChat",
      ])
      .describe(
        "writeScript = a NEW, separate piece of long-form content. editBlock = change one paragraph of an existing script, leaving the rest valid. rewriteScript = restructure an existing script in place (add/remove/reorder an item, or anything that makes the numbering or intro inconsistent). createMindmap = mindmap/diagram. answerInChat = anything else.",
      ),
    title: z.string().optional().describe("writeScript: short node label."),
    nodeId: z
      .string()
      .optional()
      .describe("editBlock / rewriteScript: target script node id."),
    blockIndex: z
      .number()
      .int()
      .optional()
      .describe("editBlock: 1-based paragraph number."),
    instruction: z
      .string()
      .optional()
      .describe(
        "editBlock: what to change about that paragraph. rewriteScript: the whole change to make.",
      ),
    topic: z.string().optional().describe("createMindmap: the topic."),
  }),
});
