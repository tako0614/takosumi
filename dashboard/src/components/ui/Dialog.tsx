import { type JSX, Show } from "solid-js";

interface Props {
  open: boolean;
  /** Called on Escape key or backdrop click. */
  onClose?: () => void;
  /** Accessible dialog label. */
  label?: string;
  class?: string;
  children: JSX.Element;
}

/**
 * Generic modal overlay. Renders nothing when `open` is false. Closes on
 * backdrop click + Escape (when `onClose` is given). Generalizes the
 * ConfirmDialogRenderer overlay; callers compose their own dialog body.
 */
export default function Dialog(props: Props): JSX.Element {
  return (
    <Show when={props.open}>
      <div
        class="tg-dialog-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose?.();
        }}
      >
        <div class={`tg-dialog ${props.class ?? ""}`}>{props.children}</div>
      </div>
    </Show>
  );
}
