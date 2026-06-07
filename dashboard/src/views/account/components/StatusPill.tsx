import type { JSX } from "solid-js";

interface Props {
  /** A `.status-*` modifier class (e.g. from `controlRunStatusClass`). */
  class?: string;
  children: JSX.Element;
}

/**
 * Generic status pill: renders the `.status-pill` base plus a caller-supplied
 * `.status-*` modifier class. Callers pass the localized label as children and
 * derive the modifier from the per-enum class maps in `lib/status-labels.ts`,
 * so the enum→colour switch lives in one place per enum instead of being
 * inlined in each view. (`AppStatusPill` / `ConnectionStatusPill` key their css
 * off the raw status string and stay separate.)
 */
export default function StatusPill(props: Props) {
  return (
    <span class={`status-pill ${props.class ?? ""}`}>{props.children}</span>
  );
}
