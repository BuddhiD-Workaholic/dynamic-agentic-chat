import { memo, useCallback, useRef, useState } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCanvasStore } from "@/lib/store";
import { RenderBadge } from "@/components/RenderBadge";
import type { ScriptNodeData } from "@/lib/types";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const toHtml = (blocks: string[]) =>
  blocks.map((b) => `<p>${escapeHtml(b)}</p>`).join("") || "<p></p>";

const toBlockTexts = (editor: Editor): string[] =>
  editor.getJSON().content?.map((n) =>
    (n.content ?? []).map((c: { text?: string }) => c.text ?? "").join(""),
  ) ?? [];

// A paragraph that is NOT changing. Memoised on its text, so while a sibling
// paragraph streams, this renders exactly once and then never again.
const StaticParagraph = memo(function StaticParagraph({ text }: { text: string }) {
  return (
    <p className="stream-para">
      {text}
      <RenderBadge label="¶" className="para-badge" />
    </p>
  );
});

// The paragraph currently being written. It owns the subscription to the
// streaming buffer, which is what keeps every token confined to this one
// component: the node shell selects only primitives (see below), so it does not
// re-render at all while this does.
const LiveParagraph = memo(function LiveParagraph({ nodeId }: { nodeId: string }) {
  const content = useCanvasStore((s) => s.buffers[nodeId]?.content ?? "");
  return (
    <p className="stream-para editing">
      {content}
      <span className="caret" />
      <RenderBadge label="¶" className="para-badge" />
    </p>
  );
});

// Whole-script write. Splits the growing buffer on blank lines and freezes every
// paragraph except the last, so a long script only re-renders its final
// paragraph rather than all of them.
const WriteBody = memo(function WriteBody({ nodeId }: { nodeId: string }) {
  const content = useCanvasStore((s) => s.buffers[nodeId]?.content ?? "");
  const paras = content.split(/\n\s*\n/);
  return (
    <>
      {paras.map((p, i) =>
        i === paras.length - 1 ? (
          <p key={i} className="stream-para">
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

  // Subscribe to PRIMITIVES only, never to the buffer object.
  //
  // Each of these is constant for the whole duration of a stream, so a token
  // arriving leaves every selected value Object.is-equal and this component does
  // not re-render. The live text is subscribed one level down, by the single
  // paragraph that is actually changing. That is the difference between "the
  // node re-renders 60 times" and "one paragraph re-renders 60 times".
  const streaming = useCanvasStore((s) => !!s.buffers[id]?.streaming);
  const mode = useCanvasStore((s) => s.buffers[id]?.mode);
  const editIndex = useCanvasStore((s) => s.buffers[id]?.blockIndex);
  const bufTitle = useCanvasStore((s) => s.buffers[id]?.title);

  return (
    <div className="node script-node">
      {/* Handles appear when the node is selected. Resizing writes width/height
          back through onNodesChange, the same path React Flow uses for drags. */}
      <NodeResizer minWidth={280} minHeight={220} lineClassName="rf-resize-line" handleClassName="rf-resize-handle" />
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <span className="node-kind">script</span>
        <span className="node-title">{bufTitle || d.title}</span>
        <RenderBadge label="node" />
      </div>

      {streaming ? (
        <div className="node-body">
          {mode === "edit" ? (
            <>
              {d.blocks.map((b, i) =>
                i === editIndex ? (
                  <LiveParagraph key={i} nodeId={id} />
                ) : (
                  <StaticParagraph key={i} text={b} />
                ),
              )}
              <div className="stream-tag">
                revising paragraph {(editIndex ?? 0) + 1} — the others are frozen
              </div>
            </>
          ) : (
            <>
              <WriteBody nodeId={id} />
              <div className="stream-tag">streaming…</div>
            </>
          )}
        </div>
      ) : (
        // Keyed on `rev` so a finished stream remounts the editor with the
        // committed text. TipTap snapshots `content` once at creation and never
        // re-applies it, and React Flow syncs node `data` a commit later than
        // the store; without this key the editor mounts while blocks are still
        // empty and the node goes blank the moment streaming ends.
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

  const sync = useCallback(
    (editor: Editor) =>
      useCanvasStore.getState().commitLocalText(nodeId, toBlockTexts(editor)),
    [nodeId],
  );

  const editor = useEditor({
    extensions: [StarterKit],
    content: toHtml(data.blocks),
    immediatelyRender: false,
    editorProps: { attributes: { class: "prose-mini" } },
    // Track the raw ProseMirror range, not a paragraph index — the user may
    // select a clause, a sentence, or a span crossing paragraphs.
    onSelectionUpdate: ({ editor }) => {
      const { from, to } = editor.state.selection;
      setSel(
        to > from
          ? { from, to, text: editor.state.doc.textBetween(from, to, "\n\n") }
          : null,
      );
    },
    onBlur: ({ editor }) => sync(editor),
  });

  async function runEdit() {
    if (!editor || !sel?.text.trim() || !instruction.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);

    const { from, text: original } = sel;
    let to = sel.to;
    const fullScript = data.blocks.join("\n\n");

    // Lock the editor so typing can't shift positions mid-stream.
    editor.setEditable(false);

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
        // The replacement is spliced into an INLINE range, so it has to be a
        // single run of text. Models routinely open with a blank line and wrap
        // across lines; inserted verbatim that shows up as literal newlines
        // mid-paragraph. Normalise before it ever reaches the document.
        const fragment = acc.replace(/^\s+/, "").replace(/\s*\n+\s*/g, " ");
        if (!fragment) continue; // schema.text("") throws
        editor.view.dispatch(
          editor.state.tr.replaceWith(from, to, editor.schema.text(fragment)),
        );
        to = from + fragment.length;
      }

      if (!acc.trim()) throw new Error("empty response");
      sync(editor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "edit failed");
      // Restore the original rather than leaving a half-written fragment.
      if (to > from) {
        editor.view.dispatch(
          editor.state.tr.replaceWith(from, to, editor.schema.text(original)),
        );
      }
    } finally {
      editor.setEditable(true);
      setBusy(false);
      busyRef.current = false;
      setInstruction("");
      setSel(null);
    }
  }

  return (
    <>
      {/* nodrag/nowheel: without them React Flow swallows the drag that makes a
          text selection, and selecting is the whole interaction here. */}
      <div className="node-body nodrag nowheel">
        <EditorContent editor={editor} />
      </div>

      {/* Pinned to the bottom of the node, outside the scrolling body. A script
          taller than the node used to push its own edit controls out of view. */}
      <div className="edit-bar nodrag">
        <span className="edit-hint">
          {error ? (
            <span className="edit-error">{error}</span>
          ) : sel ? (
            `Selected “${sel.text.slice(0, 40)}${sel.text.length > 40 ? "…" : ""}”`
          ) : (
            "Select any sentence or phrase, then tell AI what to change"
          )}
        </span>
        <div className="edit-row">
          <input
            className="edit-input"
            placeholder="Add notes for AI to use…"
            value={instruction}
            disabled={!sel || busy}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runEdit();
              }
            }}
          />
          <button
            className="edit-go"
            disabled={!sel || busy || !instruction.trim()}
            onClick={runEdit}
          >
            {busy ? "…" : "Edit"}
          </button>
        </div>
      </div>
    </>
  );
}

export const ScriptNode = memo(ScriptNodeImpl);
