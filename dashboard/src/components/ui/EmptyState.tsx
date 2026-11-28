import { type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

interface Props {
  /** Leading icon (lucide element); shown on an accent-soft disc. */
  icon?: JSX.Element;
  title: JSX.Element;
  message?: JSX.Element;
  /** Action slot (e.g. a Button). */
  action?: JSX.Element;
  /**
   * Heading level of the title. Defaults to h2 under a page heading; a state
   * that replaces the whole page (not found, failed first load) passes 1 so
   * the screen still has its one h1.
   */
  headingLevel?: 1 | 2;
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
      <Dynamic component={props.headingLevel === 1 ? "h1" : "h2"} class="tg-empty-title">
        {props.title}
      </Dynamic>
      <Show when={props.message}>
        <p class="tg-empty-message">{props.message}</p>
      </Show>
      <Show when={props.action}>
        <div class="tg-empty-action">{props.action}</div>
      </Show>
    </div>
  );
}
