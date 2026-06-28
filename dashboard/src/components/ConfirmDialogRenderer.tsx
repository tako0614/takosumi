import { Show } from "solid-js";
import { Icons } from "../lib/Icons.tsx";
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
        onKeyDown={(e) => {
          if (e.key === "Escape") handleCancel();
        }}
      >
        <div class="tg-confirm-card">
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
              onClick={() => handleCancel()}
            >
              {state().cancelText || "キャンセル"}
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
