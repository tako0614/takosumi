import { type JSX, Show } from "solid-js";

interface Props {
  eyebrow?: JSX.Element;
  title: JSX.Element;
  subtitle?: JSX.Element;
  /** Right-aligned actions slot. */
  actions?: JSX.Element;
}

/** Standard page header: eyebrow → title → subtitle, with an actions slot. */
export default function PageHeader(props: Props): JSX.Element {
  return (
    <div class="tg-page-header">
      <div class="tg-page-header-text">
        <Show when={props.eyebrow}>
          <div class="tg-eyebrow">{props.eyebrow}</div>
        </Show>
        <h1 class="tg-page-title">{props.title}</h1>
        <Show when={props.subtitle}>
          <p class="tg-page-subtitle">{props.subtitle}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class="tg-page-actions">{props.actions}</div>
      </Show>
    </div>
  );
}
