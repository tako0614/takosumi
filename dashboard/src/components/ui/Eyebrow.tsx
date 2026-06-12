import type { JSX } from "solid-js";

/** Uppercase tracked eyebrow label on an accent-soft pill. */
export default function Eyebrow(props: { class?: string; children: JSX.Element }): JSX.Element {
  return <span class={`tg-eyebrow ${props.class ?? ""}`}>{props.children}</span>;
}
