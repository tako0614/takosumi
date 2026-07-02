import { For, Show, type JSX } from "solid-js";

export interface MobilePreviewSectionProps {
  readonly title: string;
  readonly ariaLabel?: string;
  readonly detail?: JSX.Element;
  readonly actions?: JSX.Element;
  readonly class?: string;
  readonly children: JSX.Element;
}

export interface MobilePreviewListProps {
  readonly ariaLabel?: string;
  readonly class?: string;
  readonly children: JSX.Element;
}

export interface MobilePreviewCardProps {
  readonly class?: string;
  readonly children: JSX.Element;
}

export interface MobileComposeSectionProps {
  readonly title: string;
  readonly ariaLabel?: string;
  readonly class?: string;
  readonly children: JSX.Element;
}

export interface MobileComposeFormProps {
  readonly class?: string;
  readonly onSubmit?: JSX.EventHandlerUnion<HTMLFormElement, SubmitEvent>;
  readonly children: JSX.Element;
}

export interface MobileComposeFieldProps {
  readonly label: string;
  readonly class?: string;
  readonly children: JSX.Element;
}

export interface MobileComposeFooterProps {
  readonly detail?: JSX.Element;
  readonly class?: string;
  readonly children: JSX.Element;
}

export interface MobileSegmentedControlOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface MobileSegmentedControlProps<Value extends string> {
  readonly ariaLabel: string;
  readonly value: Value;
  readonly options: readonly MobileSegmentedControlOption<Value>[];
  readonly disabled?: boolean;
  readonly class?: string;
  readonly onChange: (value: Value) => void;
}

export function MobilePreviewSection(props: MobilePreviewSectionProps) {
  const hasHeaderDetail = () =>
    props.detail !== undefined || props.actions !== undefined;

  return (
    <section
      class={mobileClass("preview-section", props.class)}
      aria-label={props.ariaLabel ?? props.title}
    >
      <Show when={hasHeaderDetail()} fallback={<h3>{props.title}</h3>}>
        <div class="preview-section-heading">
          <div>
            <h3>{props.title}</h3>
            <Show when={props.detail}>
              {(detail) => <small>{detail()}</small>}
            </Show>
          </div>
          <Show when={props.actions}>
            {(actions) => (
              <div class="preview-section-actions">{actions()}</div>
            )}
          </Show>
        </div>
      </Show>
      {props.children}
    </section>
  );
}

export function MobilePreviewList(props: MobilePreviewListProps) {
  return (
    <ul
      class={mobileClass("preview-list", props.class)}
      aria-label={props.ariaLabel}
    >
      {props.children}
    </ul>
  );
}

export function MobilePreviewCard(props: MobilePreviewCardProps) {
  return (
    <div class={mobileClass("preview-item", props.class)}>
      {props.children}
    </div>
  );
}

export function MobileComposeSection(props: MobileComposeSectionProps) {
  return (
    <section
      class={mobileClass("compose-section", props.class)}
      aria-label={props.ariaLabel ?? props.title}
    >
      <h3>{props.title}</h3>
      {props.children}
    </section>
  );
}

export function MobileComposeForm(props: MobileComposeFormProps) {
  return (
    <form
      class={mobileClass("compose-form", props.class)}
      onSubmit={props.onSubmit}
    >
      {props.children}
    </form>
  );
}

export function MobileComposeField(props: MobileComposeFieldProps) {
  return (
    <label class={mobileClass("compose-field", props.class)}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

export function MobileComposeFooter(props: MobileComposeFooterProps) {
  return (
    <div class={mobileClass("compose-footer", props.class)}>
      <small>{props.detail}</small>
      {props.children}
    </div>
  );
}

export function MobileSegmentedControl<Value extends string>(
  props: MobileSegmentedControlProps<Value>,
) {
  return (
    <div
      class={mobileClass("segmented-control", props.class)}
      aria-label={props.ariaLabel}
    >
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            class="segment"
            aria-pressed={props.value === option.value}
            disabled={props.disabled || option.disabled}
            onClick={() => props.onChange(option.value)}
          >
            <span>{option.label}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function mobileClass(...values: readonly (string | undefined)[]): string {
  return values
    .flatMap((value) => value?.split(/\s+/) ?? [])
    .filter(Boolean)
    .join(" ");
}
