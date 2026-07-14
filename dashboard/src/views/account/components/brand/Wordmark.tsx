import type { JSX } from "solid-js";
import LogoMark from "./LogoMark.tsx";

interface Props {
  size?: number;
  href?: string;
  productName?: string;
  class?: string;
}

/**
 * Takosumi wordmark — provided logo mark + product name.
 */
export default function Wordmark(props: Props): JSX.Element {
  const inner = (
    <>
      <span aria-hidden="true">
        <LogoMark size={props.size ?? 26} />
      </span>
      <span class="wordmark-text">
        {props.productName ?? "Takosumi"}
      </span>
    </>
  );
  return props.href === undefined ? (
    <span class={`wordmark ${props.class ?? ""}`}>{inner}</span>
  ) : (
    <a href={props.href} class={`wordmark ${props.class ?? ""}`}>
      {inner}
    </a>
  );
}
