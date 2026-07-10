import {
  children as resolveChildren,
  createEffect,
  createUniqueId,
  type JSX,
  Show,
  splitProps,
} from "solid-js";

interface FieldProps {
  label?: JSX.Element;
  hint?: JSX.Element;
  error?: JSX.Element;
  required?: boolean;
  class?: string;
  /**
   * Wrapper element. Default "label" implicitly associates the label with the
   * single control it wraps. Use "group" when the control is itself a <label>
   * (e.g. Checkbox) — wrapping that in another <label> is invalid nested markup.
   */
  as?: "label" | "group";
  children: JSX.Element;
}

/** Field wrapper: label (+required marker) + control + hint/error. */
export function FormField(props: FieldProps): JSX.Element {
  const errorId = createUniqueId();
  // The control arrives as already-rendered caller JSX, so required/error
  // semantics are applied to the resolved DOM node instead of via props (the
  // visual `*` marker and error span alone expose nothing to AT).
  const resolved = resolveChildren(() => props.children);
  const control = (): HTMLElement | null => {
    for (const node of resolved.toArray()) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches("input, select, textarea")) return node;
      const nested = node.querySelector("input, select, textarea");
      if (nested) return nested as HTMLElement;
    }
    return null;
  };
  createEffect(() => {
    const el = control();
    if (!el) return;
    if (props.required) el.setAttribute("aria-required", "true");
    else el.removeAttribute("aria-required");
  });
  createEffect(() => {
    const el = control();
    if (!el) return;
    if (props.error) el.setAttribute("aria-describedby", errorId);
    else if (el.getAttribute("aria-describedby") === errorId) {
      el.removeAttribute("aria-describedby");
    }
  });
  const body = (
    <>
      <Show when={props.label}>
        <span class="tg-field-label">
          {props.label}
          <Show when={props.required}>
            <span class="tg-field-required" aria-hidden="true">
              *
            </span>
          </Show>
        </span>
      </Show>
      {resolved()}
      <Show when={props.hint && !props.error}>
        <span class="tg-field-hint">{props.hint}</span>
      </Show>
      <Show when={props.error}>
        <span class="tg-field-error" id={errorId} role="alert">
          {props.error}
        </span>
      </Show>
    </>
  );
  return props.as === "group" ? (
    <div class={`tg-field ${props.class ?? ""}`} role="group">
      {body}
    </div>
  ) : (
    <label class={`tg-field ${props.class ?? ""}`}>{body}</label>
  );
}

interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input(props: InputProps): JSX.Element {
  const [local, rest] = splitProps(props, ["invalid", "class"]);
  return (
    <input
      {...rest}
      class={`tg-input ${local.invalid ? "tg-input-invalid" : ""} ${local.class ?? ""}`}
      aria-invalid={local.invalid ? "true" : undefined}
    />
  );
}

interface SelectProps extends JSX.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export function Select(props: SelectProps): JSX.Element {
  const [local, rest] = splitProps(props, ["invalid", "class", "children"]);
  return (
    <select
      {...rest}
      class={`tg-select ${local.invalid ? "tg-select-invalid" : ""} ${local.class ?? ""}`}
      aria-invalid={local.invalid ? "true" : undefined}
    >
      {local.children}
    </select>
  );
}

interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea(props: TextareaProps): JSX.Element {
  const [local, rest] = splitProps(props, ["invalid", "class"]);
  return (
    <textarea
      {...rest}
      class={`tg-textarea ${local.invalid ? "tg-textarea-invalid" : ""} ${local.class ?? ""}`}
      aria-invalid={local.invalid ? "true" : undefined}
    />
  );
}

interface CheckboxProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  label: JSX.Element;
}

export function Checkbox(props: CheckboxProps): JSX.Element {
  const [local, rest] = splitProps(props, ["label", "class"]);
  return (
    <label class={`tg-checkbox ${local.class ?? ""}`}>
      <input type="checkbox" {...rest} />
      <span>{local.label}</span>
    </label>
  );
}
