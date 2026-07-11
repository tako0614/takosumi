/**
 * Root error backstop for the dashboard SPA.
 *
 * SolidJS rethrows when an errored resource is read; without a boundary a
 * single transient 5xx mid-render white-screens whole subtrees (round-3 audit
 * H1). This wraps the whole `<Router>` tree so any uncaught render error falls
 * back to a calm, reload-able card instead of a blank page. Per-view guards
 * (owned elsewhere) handle graceful inline retries — this is the last resort.
 *
 * Layout reuses the existing tokenized auth-panel classes (no new CSS). The
 * reduced-motion preference is honored globally by base.css; nothing here
 * animates.
 */
import { ErrorBoundary as SolidErrorBoundary, type JSX } from "solid-js";
import { t } from "../i18n/index.ts";

export default function ErrorBoundary(props: {
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <SolidErrorBoundary
      fallback={(err) => {
        // Log for diagnostics; the visible copy stays generic and reassuring.
        console.error("[dashboard] Unhandled UI error", err);
        return (
          <main class="auth-page">
            <div class="sign-in-panel notfound-panel">
              <h1 class="sign-in-title">{t("errorBoundary.title")}</h1>
              <p class="sign-in-sub">{t("errorBoundary.body")}</p>
              <button
                type="button"
                class="tg-btn tg-btn-primary"
                onClick={() => {
                  if (typeof location !== "undefined") location.reload();
                }}
              >
                {t("errorBoundary.reload")}
              </button>
            </div>
          </main>
        );
      }}
    >
      {props.children}
    </SolidErrorBoundary>
  );
}
