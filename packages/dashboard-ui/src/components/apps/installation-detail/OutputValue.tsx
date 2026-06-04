import { Show } from "solid-js";

export default function OutputValue(props: { readonly value: unknown }) {
  const value = () => props.value;
  return (
    <Show
      when={typeof value() === "string" ? (value() as string) : undefined}
      fallback={<code>{JSON.stringify(value())}</code>}
    >
      {(text) => (
        <Show
          when={text().startsWith("https://") || text().startsWith("http://")}
          fallback={<code>{text()}</code>}
        >
          <a href={text()}>{text()}</a>
        </Show>
      )}
    </Show>
  );
}
