import { For, type JSX } from "solid-js";
import { A } from "@solidjs/router";

export interface TabItem {
  href: string;
  label: JSX.Element;
  /** Exact-match active (default matches prefix too). */
  end?: boolean;
}

interface Props {
  items: readonly TabItem[];
  class?: string;
  "aria-label"?: string;
}

/**
 * Router-driven tab strip (detail-nav / account-nav). Uses @solidjs/router <A>
 * so the active tab is derived from the URL; `.active` is applied by the router.
 */
export default function Tabs(props: Props): JSX.Element {
  return (
    <nav
      class={`tg-tabs ${props.class ?? ""}`}
      aria-label={props["aria-label"]}
    >
      <For each={props.items}>
        {(t) => (
          <A href={t.href} class="tg-tab" end={t.end} activeClass="active">
            {t.label}
          </A>
        )}
      </For>
    </nav>
  );
}
