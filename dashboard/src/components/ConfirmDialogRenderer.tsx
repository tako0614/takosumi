import { createEffect, onCleanup, Show } from "solid-js";
import { Icons } from "../lib/Icons.tsx";
import { t } from "../i18n/index.ts";
import {
  useConfirmDialogActions,
  useConfirmDialogState,
} from "../lib/confirm-dialog.ts";
import { openModalDialog } from "../lib/modal-dialog.ts";

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
  let overlayRef: HTMLDivElement | undefined;
  let cardRef: HTMLDivElement | undefined;
  let cancelRef: HTMLButtonElement | undefined;

  // aria-modal contract from lib/modal-dialog.ts — shared with the store's
  // detail drawer. The local copy this replaces collected only `button` as
  // focusable, so the first link or input added to this card would have let
  // Tab walk out onto the inert page behind it.
  createEffect(() => {
    if (!state().isOpen) return;
    onCleanup(
      openModalDialog({
        overlay: () => overlayRef,
        surface: () => cardRef,
        initialFocus: () => cancelRef,
        onDismiss: handleCancel,
      }),
    );
  });

  return (
    <Show when={state().isOpen}>
      <div
        class="tg-confirm-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={state().title}
        // The message body is what the user is actually confirming — wire it
        // as the accessible description so SR users hear it with the title.
        aria-describedby="tg-confirm-message"
        ref={overlayRef}
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
              aria-hidden="true"
            />
          </div>
          <h3 class="tg-confirm-title">{state().title}</h3>
          <p class="tg-confirm-message" id="tg-confirm-message">
            {state().message}
          </p>
          <div class="tg-confirm-actions">
            {/* The app's highest-stakes surface used the legacy `.btn`
                taxonomy — square corners, display font, different height —
                so every destructive confirmation looked off-system against the
                page behind it. */}
            <button
              type="button"
              class="tg-btn tg-btn-secondary"
              ref={cancelRef}
              onClick={() => handleCancel()}
            >
              {state().cancelText || t("common.cancel")}
            </button>
            <button
              type="button"
              class="tg-btn"
              classList={{
                "tg-btn-danger": Boolean(state().danger),
                "tg-btn-primary": !state().danger,
              }}
              onClick={() => handleConfirm()}
            >
              {state().confirmText || t("common.ok")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
