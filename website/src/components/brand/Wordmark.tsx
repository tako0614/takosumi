import type { JSX } from "solid-js";
import GeometricMark from "./GeometricMark.tsx";
import InkdropMark from "./InkdropMark.tsx";

interface Props {
  variant?: "geometric" | "inkdrop";
  size?: number;
  class?: string;
}

/**
 * Wordmark = mark + "Takosumi" text. Used in nav + footer.
 * Variant chooses which mark to lead with; the default is geometric
 * (subject to user pick post-visual-review).
 */
export default function Wordmark(props: Props): JSX.Element {
  const Mark = () =>
    props.variant === "inkdrop" ? (
      <InkdropMark size={props.size ?? 28} />
    ) : (
      <GeometricMark size={props.size ?? 28} />
    );
  return (
    <a
      href="/"
      class={`wordmark ${props.class ?? ""}`}
      aria-label="Takosumi home"
    >
      <Mark />
      <span class="wordmark-text">Takosumi</span>
    </a>
  );
}
