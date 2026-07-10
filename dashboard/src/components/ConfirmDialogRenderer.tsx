import { createEffect, onCleanup, Show } from "solid-js";
import { Icons } from "../lib/Icons.tsx";
import { t } from "../i18n/index.ts";
import {
  useConfirmDialogActions,
  useConfirmDialogState,
} from "../lib/confirm-dialog.ts";

/**
 * Self-contained confirm-dialog renderer for the Takosumi dashboard SPA.
 *
 * The takos product shell renders its own `ConfirmDialogRenderer` (backed by
 * the takos UI kit + `--color-*` Tailwind tokens). The dashboard cannot depend
 * on that shell, so it ships this lightweight overlay driven by the dashboard's
 * own `confirm-dialog` signal store and styled only with the `--tg-*` tokens
 * that travel in account.css. Mounted once from `AppShell`, so it is present on
 * every account / capsules screen both standalone and when the dashboard
 * is consumed in-process via the takos web vite alias.
 */
export function ConfirmDialogRenderer() {
  const state = useConfirmDialogState();
  const { handleConfirm, handleCancel } = useConfirmDialogActions();
  let cardRef: HTMLDivElement | undefined;
  let cancelRef: HTMLButtonElement | undefined;

  // aria-modal contract: while open, focus moves INTO the dialog (so Escape
  // and Tab actually reach it), Tab cycles inside, Escape cancels, and focus
  // returns to the previously-focused element on close.
  createEffect(() => {
    if (!state().isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => cancelRef?.focus());
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
        return;
      }
      if (e.key === "Tab" && cardRef) {
        const focusables = Array.from(
          cardRef.querySelectorAll<HTMLElement>("button"),
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus?.();
    });
  });

  return (
    <Show when={state().isOpen}>
      <div
        class="tg-confirm-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={state().title}
        onClick={(e) => {
          if (e.target === e.currentTarget) handleCancel();
        }}
      >
        <div class="tg-confirm-card" ref={cardRef}>
          <div
            class="tg-confirm-icon"
            classList={{ danger: Boolean(state().danger) }}
          >
            <Icons.AlertTriangle
              style={{ width: "1.25rem", height: "1.25rem" }}
            />
          </div>
          <h3 class="tg-confirm-title">{state().title}</h3>
          <p class="tg-confirm-message">{state().message}</p>
          <div class="tg-confirm-actions">
            <button
              type="button"
              class="btn btn-secondary"
              ref={cancelRef}
              onClick={() => handleCancel()}
            >
              {state().cancelText || t("common.cancel")}
            </button>
            <button
              type="button"
              class="btn"
              classList={{
                "btn-danger": Boolean(state().danger),
                "btn-primary": !state().danger,
              }}
              onClick={() => handleConfirm()}
            >
              {state().confirmText || "OK"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
