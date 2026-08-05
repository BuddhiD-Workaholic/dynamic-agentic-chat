import { useEffect, useRef } from "react";

// Per-node render counter — the in-app version of React DevTools
// "highlight updates". While a script streams, only that node's counter should
// climb; every other node must stay at 1.
//
// The flash is driven by direct DOM mutation rather than state ON PURPOSE.
// Using `setState` inside an effect with no dependency array (the obvious
// implementation) makes the badge re-render itself forever: render -> setState
// -> render -> cleanup cancels the timer -> new timer -> setState -> ...
// roughly 11 renders/second in every node, with nothing streaming. That turns
// the instrument into a liar: it reports constant re-rendering and so disproves
// the very isolation it exists to demonstrate. Touching the DOM schedules no
// render, so the dependency-free effect is safe here.
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
