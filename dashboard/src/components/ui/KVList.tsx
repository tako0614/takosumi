import { For, type JSX, Show } from "solid-js";

export interface KVItem {
  label: JSX.Element;
  /** Hide a row entirely when its value is nullish. */
  value: JSX.Element;
}

interface Props {
  items: readonly KVItem[];
  class?: string;
}

/** Definition list (dt/dd grid) for key/value detail rows. */
export default function KVList(props: Props): JSX.Element {
  return (
    <dl class={`tg-kv ${props.class ?? ""}`}>
      <For each={props.items}>
        {(item) => (
          <Show when={item.value != null}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </Show>
        )}
      </For>
    </dl>
  );
}
