import { type JSX, Show } from "solid-js";

interface CardProps {
  /** Add the accent hover-glow + lift (for clickable / interactive cards). */
  hover?: boolean;
  class?: string;
  children: JSX.Element;
}

/** Surface container (border + elevated bg). `hover` adds the accent glow lift. */
export function Card(props: CardProps): JSX.Element {
  return (
    <div
      class={`tg-card ${props.hover ? "tg-card-hover" : ""} ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

interface CardHeaderProps {
  title: JSX.Element;
  subtitle?: JSX.Element;
  /** Right-aligned actions slot. */
  actions?: JSX.Element;
}

/** Card header: title + optional subtitle on the left, actions on the right. */
export function CardHeader(props: CardHeaderProps): JSX.Element {
  return (
    <div class="tg-card-header">
      <div class="tg-card-header-text">
        <p class="tg-card-title">{props.title}</p>
        <Show when={props.subtitle}>
          <p class="tg-card-subtitle">{props.subtitle}</p>
        </Show>
      </div>
      <Show when={props.actions}>
        <div>{props.actions}</div>
      </Show>
    </div>
  );
}

/** A divided section within a Card (gets a top rule when not first). */
export function CardSection(props: {
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class={`tg-card-section ${props.class ?? ""}`}>{props.children}</div>
  );
}
