import type { JSX } from "solid-js";

/** Label + value metric block. */
export default function Stat(props: { label: JSX.Element; value: JSX.Element; class?: string }): JSX.Element {
  return (
    <div class={`tg-stat ${props.class ?? ""}`}>
      <span class="tg-stat-label">{props.label}</span>
      <span class="tg-stat-value">{props.value}</span>
    </div>
  );
}
