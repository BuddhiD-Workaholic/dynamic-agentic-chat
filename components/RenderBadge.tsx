import { useEffect, useRef } from "react";

// Per-node render counter. The flash is direct DOM mutation, not state —
// setState in a dependency-free effect would re-render the badge forever and
// falsely report constant re-rendering.
export function RenderBadge({
  label,
  className = "render-badge",
}: {
  label: string;
  className?: string;
}) {
  const count = useRef(0);
  const el = useRef<HTMLSpanElement>(null);
  count.current += 1;

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    node.textContent = `${label} · ${count.current}`;
    node.dataset.flash = "1";
    const t = setTimeout(() => {
      node.dataset.flash = "0";
    }, 180);
    return () => clearTimeout(t);
  });

  return (
    <span
      ref={el}
      className={className}
      data-flash="0"
      title="Times this component has rendered"
    >
      {label} · {count.current}
    </span>
  );
}
