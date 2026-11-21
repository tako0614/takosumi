import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import type { HomeApp } from "../../lib/home-apps.ts";

type Position = () => JSX.CSSProperties;

/** Continuous rows with a bounded DOM. A focused tile stays mounted independently of the viewport. */
export default function HomeAppGrid(props: {
  readonly apps: readonly HomeApp[];
  readonly labelId: string;
  readonly render: (app: HomeApp, position: Position) => JSX.Element;
  readonly footer?: (position: Position) => JSX.Element;
  readonly onVisible: (apps: readonly HomeApp[]) => void;
  readonly onNearEnd: () => void;
}) {
  let grid!: HTMLUListElement;
  const [viewport, setViewport] = createSignal({ start: 0, end: 16, columns: 1, pitch: 132, gap: 0 });
  const [focusedId, setFocusedId] = createSignal<string>();
  const count = () => props.apps.length + (props.footer ? 1 : 0);
  const visible = createMemo(() => props.apps.slice(viewport().start, viewport().end), [], {
    equals: (a, b) => a.length === b.length && a.every((app, i) => app === b[i]),
  });
  const positions = createMemo(() => new Map(props.apps.map((app, index) => [app.id, index])));
  const rendered = createMemo(() => {
    const shown = visible();
    const focused = props.apps.find((app) => app.id === focusedId());
    return focused && !shown.includes(focused)
      ? [...shown, focused].sort((a, b) => (positions().get(a.id) ?? 0) - (positions().get(b.id) ?? 0))
      : shown;
  });
  const position = (index: number): JSX.CSSProperties => ({
    "grid-row": Math.floor(index / viewport().columns) + 1,
    "grid-column": index % viewport().columns + 1,
  });
  const height = () => Math.max(0, Math.ceil(count() / viewport().columns) * viewport().pitch - viewport().gap);
  let frame = 0;
  function measure() {
    frame = 0;
    const css = getComputedStyle(grid);
    // Explicit child positions can create implicit CSS tracks during resize.
    // Derive the new column count from available width, never those old tracks.
    const columnSize = css.getPropertyValue("--home-column-min").trim();
    const minimum = columnSize.endsWith("%") ? grid.clientWidth * parseFloat(columnSize) / 100 : parseFloat(columnSize);
    const columnGap = parseFloat(css.columnGap) || 0;
    const columns = Math.max(1, Math.floor((grid.clientWidth + columnGap) / (minimum + columnGap)));
    const gap = parseFloat(css.rowGap) || 0;
    const pitch = parseFloat(css.gridAutoRows) + gap;
    if (!Number.isFinite(pitch) || pitch <= 0) return;
    const top = grid.getBoundingClientRect().top;
    const firstRow = Math.max(0, Math.floor(-top / pitch) - 2);
    const lastRow = Math.max(firstRow + 1, Math.ceil((innerHeight - top) / pitch) + 2);
    const start = Math.min(firstRow * columns, Math.max(0, Math.floor((count() - 1) / columns) * columns));
    const end = Math.max(start, Math.min(count(), lastRow * columns));
    const next = { start, end, columns, pitch, gap };
    setViewport((old) => old.start === start && old.end === end && old.columns === columns && old.pitch === pitch && old.gap === gap ? old : next);
    if (end >= count()) props.onNearEnd();
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(measure); }
  function focusChanged() {
    queueMicrotask(() => setFocusedId(grid.querySelector<HTMLElement>("[data-capsule-id]:focus-within")?.dataset.capsuleId));
  }
  onMount(() => {
    const resize = new ResizeObserver(schedule);
    resize.observe(grid);
    document.addEventListener("scroll", schedule, true);
    globalThis.addEventListener("resize", schedule);
    schedule();
    onCleanup(() => {
      resize.disconnect();
      document.removeEventListener("scroll", schedule, true);
      globalThis.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    });
  });
  createEffect(() => { props.apps; props.footer; schedule(); });
  createEffect(() => { const apps = visible(); untrack(() => props.onVisible(apps)); });
  return <ul ref={grid} class="av-launcher av-home-grid" aria-labelledby={props.labelId}
    style={{ height: `${height()}px`, "grid-template-columns": `repeat(${viewport().columns}, minmax(0, 1fr))` }} onFocusIn={focusChanged} onFocusOut={focusChanged}>
    <For each={rendered()}>{(app) => props.render(app, () => position(positions().get(app.id) ?? 0))}</For>
    <Show when={props.footer && viewport().end > props.apps.length}>
      {props.footer?.(() => position(props.apps.length))}
    </Show>
  </ul>;
}
