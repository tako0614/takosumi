/**
 * Product visuals — real screenshots of the Takosumi dashboard, captured
 * from the running SPA (public/screens). Rendered inside ledger records:
 * full width, one hairline frame, square edges.
 */
import type { JSX } from "solid-js";

export function ProductShot(props: {
  src: string;
  alt: string;
  w?: number;
  h?: number;
}): JSX.Element {
  return (
    <img
      class="shot"
      src={props.src}
      alt={props.alt}
      width={props.w ?? 1600}
      height={props.h ?? 1000}
      decoding="async"
    />
  );
}
