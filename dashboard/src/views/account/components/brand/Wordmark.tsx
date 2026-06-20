import type { JSX } from "solid-js";
import GeometricMark from "./GeometricMark.tsx";

interface Props {
  size?: number;
  href?: string;
  showSub?: boolean;
  class?: string;
}

/**
 * Takosumi wordmark — geometric mark + product name.
 * Cloud deployments may opt into the subtitle explicitly.
 */
export default function Wordmark(props: Props): JSX.Element {
  const inner = (
    <>
      <span aria-hidden="true">
        <GeometricMark size={props.size ?? 26} />
      </span>
      <span class="wordmark-text">
        Takosumi
        {props.showSub === true && (
          <span class="wordmark-sub" style="margin-left:6px">
            Cloud
          </span>
        )}
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
