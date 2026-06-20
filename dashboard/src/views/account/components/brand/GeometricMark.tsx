import type { JSX } from "solid-js";

interface Props {
  size?: number;
  class?: string;
  title?: string;
}

export default function GeometricMark(props: Props): JSX.Element {
  const size = () => props.size ?? 48;
  return (
    <img
      src="/tako.png"
      width={size()}
      height={size()}
      alt={props.title ?? "Takosumi logo"}
      class={`takosumi-brand-mark ${props.class ?? ""}`}
    />
  );
}
