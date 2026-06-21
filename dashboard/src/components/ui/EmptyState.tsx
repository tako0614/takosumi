import { type JSX, Show } from "solid-js";

interface Props {
  /** Leading icon (lucide element); shown on an accent-soft disc. */
  icon?: JSX.Element;
  title: JSX.Element;
  message?: JSX.Element;
  /** Action slot (e.g. a Button). */
  action?: JSX.Element;
}

/** Empty state: icon + title + message + optional action. */
export default function EmptyState(props: Props): JSX.Element {
  return (
    <div class="tg-empty">
      <Show when={props.icon}>
        <span class="tg-empty-icon" aria-hidden="true">
          {props.icon}
        </span>
      </Show>
      <h2 class="tg-empty-title">{props.title}</h2>
      <Show when={props.message}>
        <p class="tg-empty-message">{props.message}</p>
      </Show>
      <Show when={props.action}>
        <div class="tg-empty-action">{props.action}</div>
      </Show>
    </div>
  );
}
