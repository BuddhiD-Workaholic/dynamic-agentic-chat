import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Handle, NodeResizer, Position, useStore, type NodeProps } from "@xyflow/react";
import { EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { useCanvasStore } from "@/lib/store";
import { RenderBadge } from "@/components/RenderBadge";
import type { ScriptNodeData } from "@/lib/types";

// Paints the range the AI is acting on, independent of browser focus — the
// moment the popover's input is focused, the browser drops the document
// selection entirely, so ::selection has nothing left to paint. A decoration
// is drawn by ProseMirror itself, so it survives focus moving away.
const aiRangeKey = new PluginKey<DecorationSet>("aiRange");

const AiRangeHighlight = Extension.create({
  name: "aiRangeHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: aiRangeKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(aiRangeKey) as
              | { from: number; to: number }
              | null
              | undefined;
            if (meta === null) return DecorationSet.empty;
            if (meta) {
              return DecorationSet.create(tr.doc, [
                Decoration.inline(meta.from, meta.to, { class: "ai-range" }),
              ]);
            }
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => aiRangeKey.getState(state),
        },
      }),
    ];
  },
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const toHtml = (blocks: string[]) =>
  blocks.map((b) => `<p>${escapeHtml(b)}</p>`).join("") || "<p></p>";

const toBlockTexts = (editor: Editor): string[] =>
  editor.getJSON().content?.map((n) =>
    (n.content ?? []).map((c: { text?: string }) => c.text ?? "").join(""),
  ) ?? [];

// Memoised on text, so a sibling paragraph streaming doesn't re-render this.
const StaticParagraph = memo(function StaticParagraph({ text }: { text: string }) {
  return (
    <p className="stream-para">
      {text}
      <RenderBadge label="¶" className="para-badge" />
    </p>
  );
});

// Follows the growing paragraph, but only if already near the bottom — so
// scrolling up to reread earlier text isn't fought on every token.
function useFollowContent(
  scrollRef: RefObject<HTMLDivElement | null>,
  elRef: RefObject<HTMLElement | null>,
  content: string,
) {
  useEffect(() => {
    const container = scrollRef.current;
    const el = elRef.current;
    if (!container || !el) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom < 120) el.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);
}

// The paragraph being written. Owns the buffer subscription, which is what
// keeps every token confined to this component instead of the node shell.
const LiveParagraph = memo(function LiveParagraph({
  nodeId,
  scrollRef,
  original,
}: {
  nodeId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  original?: string; // what this paragraph said before the edit started
}) {
  const content = useCanvasStore((s) => s.buffers[nodeId]?.content ?? "");
  const elRef = useRef<HTMLParagraphElement>(null);
  useFollowContent(scrollRef, elRef, content);

  // Reasoning models can take several seconds before the first body token —
  // holding the original text (dimmed) means nothing is ever wiped from the
  // screen before its replacement actually exists.
  const waiting = content.length === 0;

  return (
    <p className={`stream-para editing${waiting ? " awaiting" : ""}`} ref={elRef}>
      {waiting ? original ?? "" : content}
      <span className="caret" />
      <RenderBadge label="¶" className="para-badge" />
    </p>
  );
});

// Splits the growing buffer on blank lines, freezing every paragraph but the
// last so a long script only re-renders its final paragraph.
const WriteBody = memo(function WriteBody({
  nodeId,
  scrollRef,
}: {
  nodeId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const content = useCanvasStore((s) => s.buffers[nodeId]?.content ?? "");
  const paras = content.split(/\n\s*\n/);
  const elRef = useRef<HTMLParagraphElement>(null);
  useFollowContent(scrollRef, elRef, content);
  return (
    <>
      {paras.map((p, i) =>
        i === paras.length - 1 ? (
          <p key={i} className="stream-para" ref={elRef}>
            {p}
            <span className="caret" />
            <RenderBadge label="¶" className="para-badge" />
          </p>
        ) : (
          <StaticParagraph key={i} text={p} />
        ),
      )}
    </>
  );
});

function ScriptNodeImpl({ id, data }: NodeProps) {
  const d = data as ScriptNodeData;

  // Primitives only, never the buffer object — each is constant for the whole
  // stream, so this shell doesn't re-render per token. The live text is
  // subscribed one level down, by the single paragraph that's changing.
  const streaming = useCanvasStore((s) => !!s.buffers[id]?.streaming);
  const mode = useCanvasStore((s) => s.buffers[id]?.mode);
  const editIndex = useCanvasStore((s) => s.buffers[id]?.blockIndex);
  const bufTitle = useCanvasStore((s) => s.buffers[id]?.title);

  const bodyRef = useRef<HTMLDivElement>(null);

  const statusLabel =
    mode === "edit"
      ? `Revising paragraph ${(editIndex ?? 0) + 1} of ${d.blocks.length}`
      : mode === "rewrite"
        ? "Rewriting the script"
        : "Writing";

  return (
    <div className={`node script-node${streaming ? " is-active" : ""}`}>
      <NodeResizer minWidth={280} minHeight={220} lineClassName="rf-resize-line" handleClassName="rf-resize-handle" />
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        {streaming ? (
          <span className="node-status">
            <span className="status-dot" />
            {statusLabel}
          </span>
        ) : (
          <span className="node-kind">script</span>
        )}
        <span className="node-title">{bufTitle || d.title}</span>
        <RenderBadge label="node" />
      </div>

      {streaming ? (
        // nodrag/nowheel: without these, React Flow swallows the wheel event
        // for canvas zoom instead of scrolling the growing text.
        <div className="node-body nodrag nowheel" ref={bodyRef}>
          {mode === "edit" ? (
            d.blocks.map((b, i) =>
              i === editIndex ? (
                <LiveParagraph key={i} nodeId={id} scrollRef={bodyRef} original={b} />
              ) : (
                <StaticParagraph key={i} text={b} />
              ),
            )
          ) : (
            <WriteBody nodeId={id} scrollRef={bodyRef} />
          )}
        </div>
      ) : (
        // Keyed on `rev` so a finished stream remounts the editor with the
        // committed text — TipTap snapshots `content` once and never reapplies it.
        <IdleEditor key={d.rev} nodeId={id} data={d} />
      )}

      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function IdleEditor({ nodeId, data }: { nodeId: string; data: ScriptNodeData }) {
  const [sel, setSel] = useState<{ from: number; to: number; text: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // ProseMirror fires onSelectionUpdate continuously during a drag, not just
  // on release. Rendering the popover mid-drag put a new element under the
  // pointer and broke the native selection-extend. Gated on mouse-up instead.
  const [isSelecting, setIsSelecting] = useState(false);
  useEffect(() => {
    const onUp = () => setIsSelecting(false);
    document.addEventListener("pointerup", onUp);
    return () => document.removeEventListener("pointerup", onUp);
  }, []);

  const sync = useCallback(
    (editor: Editor) =>
      useCanvasStore.getState().commitLocalText(nodeId, toBlockTexts(editor)),
    [nodeId],
  );

  const editor = useEditor({
    extensions: [StarterKit, AiRangeHighlight],
    content: toHtml(data.blocks),
    immediatelyRender: false,
    editorProps: { attributes: { class: "prose-mini" } },
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      setSel(
        to > from
          ? { from, to, text: editor.state.doc.textBetween(from, to, "\n\n") }
          : null,
      );
    },
    // Blur, not update: commitLocalText never bumps `rev`, so this is cheap
    // and can't remount mid-edit — syncing per keystroke would churn `nodes`.
    onBlur: ({ editor }) => sync(editor),
  });

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(aiRangeKey, sel ? { from: sel.from, to: sel.to } : null),
    );
  }, [editor, sel]);

  // Dismiss on outside click or Escape, but not mid-request — there's no
  // cancel, and the doc keeps changing under a closed popover.
  useEffect(() => {
    if (!sel) return;
    const outside = (target: Node) =>
      !wrapperRef.current?.contains(target) && !popoverRef.current?.contains(target);
    const onDown = (e: MouseEvent) => {
      if (busyRef.current) return;
      if (outside(e.target as Node)) {
        setSel(null);
        setError(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        setSel(null);
        setError(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [sel]);

  async function runEdit() {
    if (!editor || !sel?.text.trim() || !instruction.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);

    const { from, text: original } = sel;
    let to = sel.to;
    const fullScript = data.blocks.join("\n\n");

    editor.setEditable(false); // lock so typing can't shift positions mid-stream

    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullScript, selectedText: original, instruction }),
      });
      // Without this check a non-2xx response streams its error body into the
      // script AS the rewritten text.
      if (!res.ok || !res.body) throw new Error(`edit failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        // Spliced into an inline range, so it must be a single run of text.
        const fragment = acc.replace(/^\s+/, "").replace(/\s*\n+\s*/g, " ");
        if (!fragment) continue; // schema.text("") throws
        editor.view.dispatch(
          editor.state.tr.replaceWith(from, to, editor.schema.text(fragment)),
        );
        to = from + fragment.length;
      }

      if (!acc.trim()) throw new Error("empty response");
      sync(editor);

      // Reselect the landed text so the loop stays tight: highlight, ask, see
      // it change, ask again — without reselecting from scratch each time.
      editor.commands.setTextSelection({ from, to });
      editor.commands.focus();
      setInstruction("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "edit failed");
      // Restore and reselect the original — a failed edit shouldn't cost the
      // user their selection.
      editor.view.dispatch(
        editor.state.tr.replaceWith(from, to, editor.schema.text(original)),
      );
      editor.commands.setTextSelection({ from, to: from + original.length });
      editor.commands.focus();
    } finally {
      editor.setEditable(true);
      setBusy(false);
      busyRef.current = false;
    }
  }

  return (
    // position:relative anchors the popover in this node's local coordinate
    // space, so it pans and zooms with the canvas for free.
    <div
      className="node-body nodrag nowheel"
      ref={wrapperRef}
      onPointerDown={() => setIsSelecting(true)}
    >
      <EditorContent editor={editor} />
      <p className="ai-hint">Select any text to ask AI to change it</p>

      {sel && editor && !isSelecting && (
        <SelectionPopover
          ref={popoverRef}
          editor={editor}
          wrapperRef={wrapperRef}
          sel={sel}
          instruction={instruction}
          setInstruction={setInstruction}
          busy={busy}
          error={error}
          onSubmit={runEdit}
        />
      )}
    </div>
  );
}

// Anchored to the selection itself, not pinned to the bottom of the node.
// Renders as an ordinary DOM descendant inside React Flow's transformed pane,
// so it moves with pan/zoom for free; `zoom` only converts the selection's
// on-screen position into this node's local coordinates.
const SelectionPopover = memo(
  function SelectionPopover({
    ref,
    editor,
    wrapperRef,
    sel,
    instruction,
    setInstruction,
    busy,
    error,
    onSubmit,
  }: {
    ref: RefObject<HTMLDivElement | null>;
    editor: Editor;
    wrapperRef: RefObject<HTMLDivElement | null>;
    sel: { from: number; to: number; text: string };
    instruction: string;
    setInstruction: (v: string) => void;
    busy: boolean;
    error: string | null;
    onSubmit: () => void;
  }) {
    // Narrowly subscribed to zoom alone, not the full viewport (which also
    // carries pan) — position already tracks panning for free via DOM nesting.
    const zoom = useStore((s) => s.transform[2]);

    // The one thing DOM nesting doesn't cover: the node's own internal scroll.
    const [, bumpOnScroll] = useState(0);
    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const onScroll = () => bumpOnScroll((n) => n + 1);
      el.addEventListener("scroll", onScroll, { passive: true });
      return () => el.removeEventListener("scroll", onScroll);
    }, [wrapperRef]);

    const wrapperEl = wrapperRef.current;
    if (!wrapperEl) return null;

    const wrapperRect = wrapperEl.getBoundingClientRect();
    const startCoords = editor.view.coordsAtPos(sel.from);
    const endCoords = editor.view.coordsAtPos(sel.to);
    const top = Math.min(startCoords.top, endCoords.top);
    const bottom = Math.max(startCoords.bottom, endCoords.bottom);
    const left = Math.min(startCoords.left, endCoords.left);
    const right = Math.max(startCoords.right, endCoords.right);

    const localWidth = wrapperRect.width / zoom;
    const rawCenterX = ((left + right) / 2 - wrapperRect.left) / zoom;
    const clampMargin = Math.min(96, localWidth / 2);
    const centerX = Math.min(
      Math.max(rawCenterX, clampMargin),
      Math.max(localWidth - clampMargin, clampMargin),
    );

    const above = top - wrapperRect.top > 100; // prefer above; below sits under the cursor
    const anchorY = ((above ? top : bottom) - wrapperRect.top) / zoom;

    return (
      <div
        ref={ref}
        className={`ai-popover nodrag ${above ? "above" : "below"}`}
        style={{ left: centerX, top: anchorY }}
      >
        <div className="ai-popover-selection">
          “{sel.text.length > 60 ? `${sel.text.slice(0, 60)}…` : sel.text}”
        </div>
        <div className="ai-popover-row">
          <input
            autoFocus
            className="ai-popover-input"
            placeholder="Tell AI what to change…"
            value={instruction}
            disabled={busy}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }}
          />
          <button
            className="ai-popover-go"
            disabled={busy || !instruction.trim()}
            onClick={onSubmit}
          >
            {busy ? <span className="spinner" /> : "Rewrite"}
          </button>
        </div>
        {error && <div className="ai-popover-error">{error}</div>}
      </div>
    );
  },
);

export const ScriptNode = memo(ScriptNodeImpl);
