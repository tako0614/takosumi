import type { JSX } from "solid-js";

interface Props {
  size?: number;
  class?: string;
}

/**
 * Wordmark = the same logo mark used by app.takosumi.com + "Takosumi" text.
 */
export default function Wordmark(props: Props): JSX.Element {
  const size = () => props.size ?? 28;
  return (
    <a
      href="/"
      class={`wordmark ${props.class ?? ""}`}
      aria-label="Takosumi home"
    >
      <img
        class="wordmark-mark"
        src="/tako.png"
        alt=""
        width={size()}
        height={size()}
        decoding="async"
      />
      <span class="wordmark-text">Takosumi</span>
    </a>
  );
}
