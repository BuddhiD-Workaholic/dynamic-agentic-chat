// Intent-gating and reference-resolution eval.
//
// Routing is probabilistic, so a single pass proves nothing — "it worked when I
// tried it" is how two separate bugs survived manual testing: a full YouTube
// script landing in the chat transcript, and an ordinal reference ("the 2nd
// script") regenerating a whole script into chat. Each case runs N times.
//
// Run the dev server first, then:  npm run eval [runs]
const BASE = process.env.EVAL_BASE_URL ?? "http://localhost:3000";
const N = Number(process.argv[2] ?? 5);

const body = (n) => [
  `Paragraph one of ${n}. Ever wonder why Minecraft is still a global phenomenon?`,
  `Paragraph two of ${n}. It is a sandbox game, so you can build, explore, or survive.`,
  `Paragraph three of ${n}. Mine resources, craft tools, fight mobs, upgrade gear.`,
  `Paragraph four of ${n}. Drop a comment with your favourite thing to build.`,
];

const ONE = [{
  nodeId: "script-mc",
  title: "Minecraft 30s TikTok Explainer",
  blocks: body("minecraft"),
}];

// Two titles are byte-identical, exactly as they come out when a user asks for
// "a TikTok script", then "a YouTube script", then "an IG script". Title
// matching cannot disambiguate these; only creation order can.
const THREE = [
  { nodeId: "script-aaa", title: "Minecraft explainer (TikTok 30s)", blocks: body("tiktok") },
  { nodeId: "script-bbb", title: "Minecraft explainer (30s)", blocks: body("youtube") },
  { nodeId: "script-ccc", title: "Minecraft explainer (30s)", blocks: body("ig") },
];

const u = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] });
const chip = (id, title, mode = "write") => ({
  id, role: "assistant",
  parts: [{ type: "data-scriptChip", id: `c-${id}`, data: { title, mode, done: true } }],
});

// The reported conversation, verbatim.
const REPORTED = [
  u("u1", "Write a 30-second TikTok script explaining Minecraft."),
  chip("a1", "Minecraft 30s TikTok Explainer"),
  u("u2", "Can you change the fist prahgraphplease"),
  chip("a2", "Minecraft 30s TikTok Explainer", "edit"),
  u("u3", "Change the midlepagrapah"),
  chip("a3", "Minecraft 30s TikTok Explainer", "edit"),
  u("u4", 'write another scriptfor me to post on youtube about "Nintendo"'),
];

// The second reported conversation: three scripts, then an ORDINAL reference.
const ORDINAL = [
  u("u1", "Write a 30-second TikTok script explaining Minecraft"),
  chip("a1", "Minecraft explainer (TikTok 30s)"),
  u("u2", "Write a 30-second youtube script explaining Minecraft"),
  chip("a2", "Minecraft explainer (30s)"),
  u("u3", "Write a 30-second IG script explaining Minecraft"),
  chip("a3", "Minecraft explainer (30s)"),
  u("u4", "Hey I want you to change the second paragapah of the 2nd script"),
];

const CASES = [
  { name: "reported: turn-4 'another script' (verbatim, typos and all)",
    messages: REPORTED, scripts: ONE, expect: "write" },
  { name: "reported: ordinal '2nd script' with duplicate titles",
    messages: ORDINAL, scripts: THREE, expect: "edit", nodeId: "script-bbb", blockIndex: 1 },
  { name: "'the last script' resolves to most recent",
    messages: [u("u1", "Shorten the first paragraph of the last script.")],
    scripts: THREE, expect: "edit", nodeId: "script-ccc", blockIndex: 0 },
  { name: "single-turn new script",
    messages: [u("u1", "Write a YouTube script about Nintendo.")], scripts: [], expect: "write" },
  { name: "second script while one exists",
    messages: [u("u1", "Write me a script about travelling in Japan.")], scripts: ONE, expect: "write" },
  { name: "partial edit of existing script",
    messages: [u("u1", "Improve the middle paragraph of the Minecraft script.")],
    scripts: ONE, expect: "edit", nodeId: "script-mc" },
  { name: "plain Q&A must NOT create a node",
    messages: [u("u1", "What are apples?")], scripts: ONE, expect: "chat" },
  { name: "mindmap must NOT write a script",
    messages: [u("u1", "Make a mindmap of video ideas.")], scripts: ONE, expect: "mindmap" },
];

async function once(messages, scripts) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, scripts }),
  });
  if (!res.ok) return { mode: "http-error" };
  let buf = "", chat = 0, mode = null, nodeId = null, blockIndex = null, mindmap = false;
  const reader = res.body.getReader(), dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.startsWith("data:")) continue;
      const p = l.slice(5).trim(); if (!p || p === "[DONE]") continue;
      let j; try { j = JSON.parse(p) } catch { continue }
      if (j.type === "text-delta") chat += (j.delta ?? "").length;
      if (j.type === "data-mindmap") mindmap = true;
      if (j.type === "data-script") { mode = j.data.mode; nodeId = j.data.nodeId; blockIndex = j.data.blockIndex; }
    }
  }
  if (mindmap) return { mode: "mindmap" };
  if (mode) return { mode, nodeId, blockIndex };
  return { mode: chat > 0 ? "chat" : "nothing", chatChars: chat };
}

function grade(c, r) {
  if (r.mode !== c.expect) return r.mode;
  if (c.nodeId && r.nodeId !== c.nodeId) return `${r.mode}:wrong-script`;
  if (c.blockIndex !== undefined && r.blockIndex !== c.blockIndex)
    return `${r.mode}:wrong-para(${r.blockIndex})`;
  // A chat reply that runs long is a regenerated script, not an answer.
  if (r.mode === "chat" && (r.chatChars ?? 0) > 900) return "chat:TOO-LONG";
  return "ok";
}

for (let i = 0; i < 30; i++) {
  try { const r = await fetch(`${BASE}/api/chat`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [u("w", "hi")], scripts: [] }) });
    if (r.ok) { await r.body.cancel(); break; } } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

const rows = [];
for (const c of CASES) {
  const got = [];
  for (let i = 0; i < N; i++) got.push(grade(c, await once(c.messages, c.scripts)));
  rows.push({ case: c.name, pass: `${got.filter((g) => g === "ok").length}/${N}`, got: got.join(",") });
}
console.log(JSON.stringify({ runsPerCase: N, rows }, null, 1));
const total = rows.reduce((a, r) => a + Number(r.pass.split("/")[0]), 0);
console.log(`OVERALL ${total}/${rows.length * N}`);
