import { For, type JSX } from "solid-js";

type Variant = "card" | "row" | "block";

const VARIANT_CLASS: Record<Variant, string> = {
  card: "tg-skel-card",
  row: "tg-skel-row",
  block: "tg-skel-block",
};

interface Props {
  variant?: Variant;
  /** Repeat count (renders a stacked group). */
  count?: number;
  class?: string;
  /** Inline style override (e.g. custom height/width). */
  style?: JSX.CSSProperties | string;
}

/** Shimmer placeholder. `variant` = card | row | block; `count` repeats it. */
export default function Skeleton(props: Props): JSX.Element {
  return (
    <For each={Array.from({ length: props.count ?? 1 })}>
      {() => (
        <div
          class={`tg-skel ${VARIANT_CLASS[props.variant ?? "card"]} ${props.class ?? ""}`}
          style={props.style}
          aria-hidden="true"
        />
      )}
    </For>
  );
}
