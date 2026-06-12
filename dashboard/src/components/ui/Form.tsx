import { type JSX, Show, splitProps } from "solid-js";

interface FieldProps {
  label?: JSX.Element;
  hint?: JSX.Element;
  error?: JSX.Element;
  required?: boolean;
  class?: string;
  children: JSX.Element;
}

/** Field wrapper: label (+required marker) + control + hint/error. */
export function FormField(props: FieldProps): JSX.Element {
  return (
    <label class={`tg-field ${props.class ?? ""}`}>
      <Show when={props.label}>
        <span class="tg-field-label">
          {props.label}
          <Show when={props.required}>
            <span class="tg-field-required" aria-hidden="true">*</span>
          </Show>
        </span>
      </Show>
      {props.children}
      <Show when={props.hint && !props.error}>
        <span class="tg-field-hint">{props.hint}</span>
      </Show>
      <Show when={props.error}>
        <span class="tg-field-error" role="alert">{props.error}</span>
      </Show>
    </label>
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
