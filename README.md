# Script Canvas — proof of concept

A minimal Next.js + React Flow build that proves four mechanics behind
"scripts get their own node on the canvas":

1. **Stream isolation** — the script streams into a canvas node, never into chat.
2. **Render isolation** — streaming one node doesn't re-render the rest of the board.
3. **Selective edits** — rewrite one selected phrase in place, with full-script context.
4. **Intent gating** — only script-like requests spawn a node; Q&A and mindmaps don't.

Stack: Next.js 15 (App Router), React 19, `@xyflow/react` 12, Vercel **AI SDK 5**,
Zustand 5, TipTap 2.

Every number in this document was measured against a running build, not estimated.

---

## Run it

```bash
npm install
cp .env.example .env      # then fill in your key
npm run dev               # http://localhost:3000
```

The app speaks plain **Chat Completions against any OpenAI-compatible endpoint**, so
only three env vars change between providers:

```bash
OPENAI_BASE_URL=https://api.openai.com/v1   # or https://api.minimax.io/v1
OPENAI_API_KEY=sk-...
MODEL=gpt-4o                                # or MiniMax-M3
```

Then, in the chat node, try in this order:

1. `Write a 30-second TikTok script explaining Minecraft.` → a node appears and streams.
2. `Write a 30-second TikTok script about travelling in Japan.` → a second node streams
   while the first one's render counter **stays frozen**.
3. `Improve the middle paragraph of the Minecraft script.` → only that paragraph changes,
   in the right node.
4. `What are apples?` → answered in chat, no node.
5. `Make a mindmap of video ideas.` → routes to a different tool, no script node.
6. Select any phrase inside a script node, type an instruction, hit **Edit**.

The board starts empty apart from the chat node — everything else is created by use.
Every node is **resizable**: select it and drag any edge or corner. Inside a script
node the text scrolls while the edit bar stays pinned to the bottom, so a script
taller than its node never hides its own controls.

With the server running, `npm run eval` scores intent gating over six cases (see
[Intent gating](#4-intent-gating)). `npm run typecheck` and `npm run build` are clean.

> Note on the provider: this was developed against **MiniMax-M3**. It works, but
> `@ai-sdk/openai` is *not* the right provider package for it — see
> [Provider notes](#provider-notes-two-things-that-bite).

---

## The key design decision: an agent decides, then a tool-free call writes

`/api/chat` runs two phases inside one `createUIMessageStream`:

```
[1] decide -> Agent({ tools, toolChoice: 'required' })   // no prose, short arguments
       listEditors() / listEditors({ nodeId })           // agent inspects the board
       => writeScript({ title }) | editBlock({ nodeId, blockIndex, instruction })
        | createMindmap({ topic }) | answerInChat()

[2] write  -> streamText({ /* NO tools */ })
       per token: writer.write({ type:'data-script', id: nodeId, data:{ …, content: acc } })
```

Phase 1 decides *what*, using the SDK's `Agent`. Phase 2 streams the *body* with no
tools attached, so **the entire output of that second call belongs to exactly one
node**. Stream isolation stops being a parsing problem and becomes a structural fact:
there is nothing to extract, and nothing that *can* leak into the transcript.

### On the literal question asked

The brief asks: *"can you extract a section of the AI streaming chunk that belongs to
the script, isolate it, and stream it into a different container?"*

Route-then-stream is a **different** answer, not just a better one, so it's worth
being explicit about the alternatives:

| Approach | How isolation works | Why not chosen |
| --- | --- | --- |
| **Delimiter parsing** | One stream; model wraps the script in sentinels; a client state machine splits it | Literally the question asked. Works anywhere, one round trip. But it rides on prompt adherence, and needs careful buffering for delimiters split across chunk boundaries. One malformed sentinel dumps a script into chat. |
| **Tool-input streaming** | Script body is a tool argument; AI SDK streams tool inputs natively | Elegant, and it *does* work here (measured below). But the body must be emitted as a JSON string — escaped newlines and quotes — and partial-JSON parsing of a half-written string is fragile. Also assumes the provider streams tool-argument deltas at all. |
| **Route, then stream** ← | The body is its own tool-free completion | Chosen. Provider-independent, no escaping, no parsing, nothing to get wrong. Costs one extra round trip (~2.0 s, measured). |

Both transports were built and measured before choosing, then the losing one was
deleted rather than left behind a flag. The numbers below are why.

### Measured: `stream` vs `tool`

Same prompts, same model, back to back, both normalised to the same `data-script`
part so the client was identical across them:

| Prompt | Transport | First body token | Total | Body chars | **Updates** | **Leaked into chat** |
| --- | --- | --- | --- | --- | --- | --- |
| TikTok script | stream | 11.9 s | 18.1 s | 999 | **129** | **0** |
| | tool | **4.8 s** | **6.6 s** | 694 | 16 | 2 |
| LinkedIn post | stream | 10.7 s | 12.8 s | 1567 | **17** | **0** |
| | tool | 9.9 s | **9.9 s** | 1511 | **1** | 2 |
| Edit one paragraph | stream | 9.3 s | 9.5 s | 214 | 5 | **0** |
| | tool | **7.3 s** | **8.4 s** | 371 | 7 | **174** |

"Updates" is how many times the body grew — i.e. how much it actually *streamed*.

**`tool` is roughly twice as fast**, since it skips the routing hop. It also loses on
the two things this feature exists for:

1. **It sometimes doesn't stream at all.** The LinkedIn body arrived in **one**
   update — 1511 characters materialising at once. That is the exact behaviour the
   brief rules out ("we don't want the text shown when the entire script is
   complete"). `stream` never dropped below 5 updates.
2. **It leaks prose into the transcript.** 174 characters of commentary landed in
   chat alongside the edit. `stream` leaked **0 characters on every run**, because a
   tool-free completion has nowhere else to put its output.

So `stream` won: the latency is real and worse, but it is the only one of the two
that keeps the guarantee the feature is named after. On a provider that streams tool
arguments smoothly and where latency dominates, `tool` would be the better call — the
implementation is in git history rather than behind a flag, because carrying two
paths for a decision already made is just complexity.

### Paragraphs are addressed by index, not uuid

`editBlock({ nodeId, blockIndex })`. The model is shown a numbered canvas snapshot and
answers about it in the same turn, so the index it reads is the index applied — stable
by construction.

This deleted three bugs that a uuid-based design had: partial-JSON streaming delivered
*truncated uuid prefixes* (so the live edit preview never matched), local editing
re-keyed ids by position anyway, and carrying stable ids through a rich-text editor
needs a custom extension.

### Choosing *which* editor is a tool call, not string matching

Nothing anywhere greps the stream to decide what to do. The only two `.split()` calls
in the codebase are `\n\s*\n`, segmenting already-isolated prose into paragraphs.

The agent inspects the board through `listEditors`, which either lists the open
editors or returns one script's numbered paragraphs in full:

```
listEditors()                      -> [{ nodeId, title, paragraphs, createdOrder, mostRecent }]
listEditors({ nodeId })            -> { paragraphs: [{ number, text }, …] }
editBlock({ nodeId, blockIndex, instruction })
```

`listEditors` has an `execute`, so the routing loop feeds its result back and
continues; the action tools deliberately do not, which is what makes the loop stop the
moment the model commits. "Improve the middle paragraph of the Minecraft script"
resolves because the model reads that list and picks.

Two details that matter more than they look:

- **Nothing about the canvas is in the prompt.** The system prompt is a fixed string
  describing the job and the tools; it does not grow with the board. An earlier
  version injected a compact index of every script, which is fine at three nodes and
  ruinous at three hundred — the board is re-sent on *every* turn. Now the agent pays
  for board context only when it needs it, and only for the one script it asks about.
  The board still travels with the request as data, but it reaches the model through
  a tool result rather than as prompt text.
- **Creation order is stated explicitly**, and the newest is marked `mostRecent`.
  Without it "the one you just wrote" is unresolvable — the model would be guessing at
  an ordering nobody told it about.

The cost is honest: an edit now takes 3 agent steps (`listEditors` → `listEditors(nodeId)`
→ `editBlock`) instead of reading a pre-injected snapshot. That is slower per edit and
constant in board size, which is the right trade at 1000 boards and the wrong one at 3.

### You can watch the agent think, and see what it cost

Routing takes several seconds — the agent is calling `listEditors`, reading a script,
then committing — and that used to be dead air. The chat now shows tool calls live, and
the token cost of the turn when it finishes:

```
listEditors  done
editBlock    running…

5,710 tokens (in 4,932 · out 778 · routing 4,848, edit 862)
```

Tool activity is a **transient** data part (status, not conversation — it never enters
the transcript), rendered by its own memoised component with its own store
subscription. Measured across all six tool events of one edit: the chat shell stayed at
`renders · 24` and the transcript at `log · 12`. Only the activity strip re-rendered.

The token breakdown is worth leaving visible, because it makes the honest cost of this
design impossible to hide:

| Turn | routing | writing | total |
| --- | --- | --- | --- |
| New script | 1,461 | 963 | 2,424 |
| **Edit one paragraph** | **4,848** | 862 | **5,710** |
| Plain Q&A | 1,467 | 401 | 1,868 |

**Routing is ~85% of the cost of an edit.** Inspect-then-act means `listEditors` returns
a script's full text into the conversation, and the agent loops over it. Writing the
actual replacement paragraph is the cheap part. If this went to production the first
optimisation would be there — cache the board read per turn, or let `listEditors` return
a paragraph range rather than the whole script — not in the streaming layer everyone
looks at first.

> Getting real numbers needed `includeUsage: true` on the provider. Without it,
> OpenAI-compatible endpoints omit the usage chunk from **streaming** responses, so
> every streamed call silently reports zero while non-streamed ones look fine.

---

## Where each mechanic lives

```
app/api/chat/route.ts          agent decides -> tool-free call writes
app/api/edit/route.ts          manual selection edit — streams ONE fragment
lib/ai/model.ts                provider + reasoning-tag stripping
lib/ai/tools.ts                listEditors, answerInChat, actions, fallback router
lib/ai/prompt.ts               system prompts (no canvas state)
scripts/eval-intent.mjs        intent-gating eval (npm run eval)
lib/store.ts                   Zustand: nodes/edges + per-node streaming BUFFERS
components/useScriptRouter.ts  routes data-script parts → store (idempotent)
components/Chat.tsx            useChat; renders text + chips only, never bodies
components/Canvas.tsx          ReactFlow; nodeTypes at module scope; chat IS a node
components/nodes/ScriptNode.tsx  streaming view + TipTap + selection→AI edit
components/RenderBadge.tsx       render counter (per node AND per paragraph)
```

### 1. Stream isolation

`Chat.tsx` renders `part.type === "text"` and nothing else; script content arrives as
`data-script` parts. Measured on a live run:

```
prompt: "Write a short LinkedIn post about remote work."
  chat text chars : 0
  script parts    : 14
  content growth  : 0, 17, 105, 164 … 790, 788      <- genuinely incremental
```

The trailing `790 → 788` is the final payload being `.trim()`ed.

### 2. Render isolation

Streaming text **never enters the React Flow `nodes` array**. It lives in a separate
`buffers` map; each `ScriptNode` subscribes only to its own slice via
`useCanvasStore(s => s.buffers[id])`, so a token for node A leaves node B's selected
value referentially unchanged (Zustand's `Object.is` check → no re-render). The `nodes`
array changes exactly twice per script: create, and final commit.

Also enforced: `nodeTypes` is defined at module scope (inline would remount every node
on every render), and node components are `React.memo`'d.

**Measured** across five consecutive script generations on one board. Each script
node's counter freezes at the value it reached while it was being written, and never
moves again as later scripts stream past it:

| Node | Written during | Renders after all 5 streams |
| --- | --- | --- |
| script A | stream 1 | **28** |
| script B | stream 2 | **22** |
| script C | stream 3 | **30** |
| script D | stream 4 | **18** |
| script E | stream 5 | 36 |
| chat node | — | see below |

Script A sat at 28 through four subsequent streams without a single re-render.

**Inside a node, the same thing holds per paragraph.** Editing one paragraph must not
re-render the other five. The node shell subscribes only to *primitives* that are
constant for the duration of a stream (`streaming`, `mode`, `blockIndex`, `title`), so
a token leaves every selected value `Object.is`-equal and the shell does not re-render
at all. The live text is subscribed one level down, by the single paragraph that is
changing; the others are `memo`'d on their text.

Measured through one edit of paragraph 4 in an 8-paragraph script, sampling on DOM
mutation so every change is caught:

| | distinct values while streaming |
| --- | --- |
| Node shell | `node · 26` — **one value, zero re-renders** |
| Paragraphs 1,2,3,5,6,7,8 | `¶ · 2` each — frozen |
| **Paragraph 4** (the target) | `¶ · 2` → `4` → `6` → `8` |

Every node shows its counter in its header. **Paragraph counters are off by default**
— they are instrumentation, and inline numbers make the script itself unreadable.
Toggle them with the **¶** button in the chat header. They are hidden in CSS rather
than unmounted, so the counts keep accruing while hidden and are already correct if
you switch them on mid-stream.

The node shell does re-render a handful of times at the *boundaries* of a stream
(entering the streaming view, committing, and React Flow re-measuring as the node
grows) — 42 → 48 across the whole edit. What it never does is re-render per token.

**The chat node is flat too, and getting there took a second fix.** An earlier version
sent the script body as an ordinary data part. Ordinary data parts are appended to
`messages`, so every token mutated the message list and the chat re-rendered once per
token — **358 renders for a single paragraph edit**. The body was isolated from the
*transcript*, but not from React.

The fix is `transient: true` on the streaming data part. Transient parts are delivered
to `useChat`'s `onData` callback and **never added to `messages`**, so the client reads
them from a callback instead of by scanning the message list. A small persistent
`data-scriptChip` part is written exactly twice (start and done) to keep a record in
the transcript. Measured over the same edit:

| | during the edit stream | across the whole edit |
| --- | --- | --- |
| Chat node | `renders · 24` — **one value, zero re-renders** | 16 → 28 |
| Node shell | `node · 8` — **one value, zero re-renders** | 6 → 12 |

358 → 12, and flat while streaming. This is also why the payload can stay *accumulated*
rather than delta-based: `onData` fires once per chunk with no replay, and an
accumulated payload self-heals if one is dropped, where a delta would silently corrupt
the script.

**The transcript is split out from the chat shell**, which fixed a worse problem than
streaming. `Chat` owns the textarea's value and `useChat`'s status, so it re-renders on
every keystroke — and before the split, each of those re-ran the whole
`messages.map()`. **Typing one character re-rendered the entire transcript.** `ChatLog`
is now `memo`'d on `messages`, so it renders only when the conversation actually
changes:

| | while typing | during the stream | whole turn |
| --- | --- | --- | --- |
| Chat shell | +24 over 12 keystrokes | one value — **zero** | 26 → 36 |
| **Transcript** (`ChatLog`) | **0** | one value — **zero** | 2 → 8 |

What remains is irreducible and semantic, not per-token: the shell re-renders when the
Send button disables and re-enables, and the transcript re-renders three times — the
user's message, the chip appearing, the chip turning ✓. Both counters are visible in
the chat header (`renders`) and top-right of the log (`log`), so you can watch typing
move one and not the other.

**Verify it yourself:** every node shows a live render counter. Create two scripts,
then ask for a third — the new node's counter climbs while both existing nodes stay
frozen. Cross-check with React DevTools → "Highlight updates when components render":
only the paragraph being written flashes.

> `reactStrictMode` is **off** (`next.config.mjs`) so counters read 1 instead of 2.
> The isolation doesn't depend on it — turn it on and the counts simply double
> uniformly.

### 3. Selective edits

Two paths, both replacing a span and streaming in place:

- **From chat** — the model calls `editBlock` with the right `nodeId`/`blockIndex`
  (from the canvas snapshot) and phase 2 streams only the replacement paragraph.
  Measured: a 532-char script produced a 206-char edit stream — the rest was never
  regenerated.
- **From selection** — select any range (a clause, a sentence, a span crossing
  paragraphs), type an instruction. `/api/edit` gets the **full script as context** but
  is instructed to return **only** the replacement, which is spliced over the tracked
  ProseMirror range as it streams.

Measured on a live edit — only the targeted paragraph moved:

```
before[3] "There's no rules, no goals, just pure creativity. Over 200 million copies sold and it's still going strong."
after[3]  "No rules, no goals — just pure creativity. Over 200 million copies sold and still going strong."
paragraphs 0,1,2,4 : byte-identical
```

### 4. Intent gating

Same routing mechanism. Measured:

```
"What are apples?"                -> 788 chars of chat text, 0 script parts, no node
"Make a mindmap of video ideas."  -> createMindmap(topic="Video Ideas"), 0 script parts
"Write a short LinkedIn post…"    -> 14 script parts, 0 chat text
```

#### This is the part that actually broke, so it has an eval

A reported bug: after three good turns, "write another script for me to post on
youtube about Nintendo" produced a **full YouTube script inside the chat transcript**
and no node. Routing is probabilistic, so "it worked when I tried it" is worthless
here. `npm run eval` runs six cases N times each against a live server:

```
reported turn-4 'another script' (verbatim, typos and all)   write    5/5
single-turn new script                                       write    5/5
second script while one exists                               write    5/5
partial edit of existing script                              edit     5/5
plain Q&A must NOT create a node                             chat     5/5
mindmap must NOT write a script                              mindmap  5/5
```

Three things had to be true to get there, and one of them was a wrong guess:

1. **The cause was not what it looked like.** The obvious theory was that assistant
   turns carry only `data-script` parts, which `convertToModelMessages` strips, so
   the model sees empty assistant turns. Tested directly: data-part-only history
   **passed**, and injecting text acknowledgements into history **failed** — prose in
   the history primes more prose. The "fix" would have caused the bug.
2. **`answerInChat`.** Making "just reply in the chat" a named tool turns *"did it
   remember to call a tool?"* into *"which tool?"* — a strictly easier question.
3. **A forced-named-function fallback.** `toolChoice: "required"` is **not reliable**
   on MiniMax-M3 — measured, it returns `finish_reason:"stop"` with 1400 characters of
   prose and no tool call. When that happens, the router re-asks with a single forced
   named function, which the provider honours **3/3 on script requests** (and 0/3 on
   questions, where falling through to chat is already correct). So the safety net
   catches precisely the dangerous case.

Honest framing: on this provider the gate is **defence in depth, not a guarantee** —
prompt steering, plus a named "do nothing" option, plus a forced-function retry. On a
provider that honours `toolChoice: "required"` (OpenAI), the first layer alone
suffices. The eval is the thing that would catch a regression, and it belongs in CI.

---

## Provider notes: two things that bite

Both were found by probing the endpoint directly before trusting the UI.

**1. Use `@ai-sdk/openai-compatible`, not `@ai-sdk/openai`.** In AI SDK 5 the official
OpenAI provider defaults to the **Responses API**, which third-party OpenAI-compatible
endpoints don't serve. `createOpenAICompatible` speaks Chat Completions, so the same
code runs on MiniMax locally and on a real OpenAI key in production.

**2. Reasoning models leak their chain of thought into `content`.** MiniMax-M3 returns
`<think>…</think>` inline in `content` rather than in a separate field. Unhandled, the
first 80 characters streamed into the script node are the model thinking out loud about
TikTok pacing. `extractReasoningMiddleware({ tagName: "think" })` peels those blocks
into reasoning parts and leaves `textStream` as pure body text. It is a no-op on
models that don't emit the tags.

**3. `toolChoice: "required"` is not reliable here.** Measured: MiniMax-M3 will return
`finish_reason:"stop"` with ~1400 characters of prose and no tool call, despite being
told a call is required. Forcing a *named* function is honoured far more often — 3/3
on script requests. Both layers are in place; see [Intent gating](#4-intent-gating).

**A prediction that was wrong, since it drove a design decision.** I expected MiniMax
to buffer tool-call arguments into one blob — its published tool-call format is XML-ish
`<invoke>`, and the vLLM parser for it buffers until the tag closes. A direct probe
**refuted the strong version**: arguments arrived in 27 incremental deltas totalling
1096 chars, so tool-input streaming does work.

The weaker version turned out to be real, though, and only showed up under
measurement: in the transport comparison one 1511-character body arrived in a **single
update**. So it streams *usually*, not *reliably* — which is why the default transport
does not depend on it.

---

## Storage: the Firestore size-limit question

Firestore caps a document at **1 MiB (1,048,576 bytes)**, and the cap counts field
names, indexes, and UTF-8 bytes — not characters. Two things make scripts hit it far
earlier than "a million characters" suggests:

- **Rich-text JSON is 3–6× the plain text.** A ProseMirror/TipTap doc wraps every
  paragraph in node objects with type/attr keys. A 40 KB script is comfortably 150 KB+
  of JSON.
- **Version history in the same document.** Keeping N revisions inline multiplies it.
  A script with 20 saved revisions is a 1 MiB document at ~8 KB of actual prose.

### Recommendation: split by role

| | Where | Why |
| --- | --- | --- |
| **Metadata** — id, title, nodeId, owner, timestamps, position, short preview | Firestore document | Small, queryable, indexable. This is what a board listing reads. |
| **Body** — one doc per paragraph, `scripts/{id}/blocks/{index}` | Firestore subcollection | **Recommended.** |
| **Large blobs / archives** | Cloud Storage, `contentPath` pointer in the doc | Fallback when a body genuinely is huge. |

**Why the blocks subcollection is the right default here** — it does triple duty:

1. **The cap stops being reachable.** Each paragraph is its own document; a script is
   bounded by paragraph count, not total size.
2. **Edits get cheap.** `editBlock` and the selection edit both write one paragraph.
   Today that's a whole-document rewrite; as a subcollection it's a single small write,
   with no whole-doc write contention between two people editing different paragraphs.
3. **It's already the data model.** This POC addresses paragraphs by index precisely
   because selective editing needs block addressing. Persistence falls out for free —
   the storage layout matches the edit granularity.

Costs to be honest about: reading a script becomes a collection read rather than one
document get (mitigate by keeping the preview inline and paginating long scripts), and
listeners are per-collection rather than per-document. Firestore also caps sustained
writes to a single document at ~1/second — another reason per-paragraph writes beat
whole-document rewrites while a user types.

**When to use Cloud Storage instead:** if bodies are large and mostly read whole
(exports, archived versions, imported transcripts), store JSON in GCS and keep a
`contentPath` in Firestore. You lose per-block writes and atomic partial updates.

**Scaling path (out of scope here):** for real-time collaborative editing, stop syncing
paragraph documents and persist a **CRDT (Yjs) document** instead — periodic snapshots
to Cloud Storage plus an append-only update log. That solves concurrent editing and the
size limit at once, but it is a much larger change and this POC doesn't need it.

---

## Deliberate simplifications

- **`data-script` carries accumulated content, not deltas.** AI SDK 5 reconciles data
  parts sharing an `id`, so each write replaces the last, which makes the client
  idempotent with no append bookkeeping. The cost is O(n²) bytes on the wire — a few MB
  for a 2 KB script, invisible here, wrong at scale. Fix: send deltas and accumulate
  client-side, trading idempotency for bandwidth.
- **Chat-driven edits are paragraph-granular**; manual selection edits are
  arbitrary-range. Sub-paragraph targeting from chat would need the model to quote the
  span it wants to replace.
- **No persistence layer is wired.** Storage is answered above, not implemented.
- **A selection spanning a paragraph break merges those paragraphs**, because the
  replacement is spliced in as a single inline text run.
- **`createMindmap` is a stub** — it renders a labelled node purely to prove a
  non-script intent routes elsewhere.
- Out of scope by design (per the brief): detach/reattach-on-click, fullscreen
  side-attach, and the full end-to-end product.

## Known rough edges

- No streaming **abort**. Navigating away mid-stream orphans the request; `settleStreams()`
  guarantees a node is never left stuck in its read-only view, but there's no stop button.
- The canvas snapshot truncates each paragraph to 160 chars to bound prompt growth. A
  very long script could become ambiguous to reference ("the middle paragraph") if many
  paragraphs share an opening.
- Node positions are naive (fixed column, stacked). No collision handling.
