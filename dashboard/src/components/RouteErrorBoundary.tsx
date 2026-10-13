/**
 * Per-page error boundary inside the authenticated shell.
 *
 * The root ErrorBoundary (index.tsx) wraps the whole Router, so before this one
 * existed a single uncaught render error on any screen replaced the ENTIRE app
 * — sidebar, top bar and tabs included — with a reload card, and nothing short
 * of a full reload (which often re-threw the same error) got the user out.
 * This boundary sits around the page content only: the chrome stays usable,
 * navigating to another page clears the error, and Retry re-mounts the page.
 * Views still own their inline load-failure states; this is the backstop.
 */
import {
  createEffect,
  ErrorBoundary as SolidErrorBoundary,
  type JSX,
  on,
} from "solid-js";
import { useLocation } from "@solidjs/router";
import { AlertCircle } from "lucide-solid";
import { Button, EmptyState } from "./ui/index.ts";
import { reloadForStaleAsset } from "../lib/chunk-reload.ts";
import { t } from "../i18n/index.ts";

function RouteErrorFallback(props: {
  readonly error: unknown;
  readonly reset: () => void;
}): JSX.Element {
  const location = useLocation();
  // A route chunk that 404s after a deploy lands here, not on the window
  // listeners — reload once onto the new build instead of showing the card.
  reloadForStaleAsset(props.error);
  // Leaving the broken page must not strand the user on its error card.
  createEffect(
    on(
      () => location.pathname,
      () => props.reset(),
      { defer: true },
    ),
  );
  return (
    <div role="alert">
      <EmptyState
        icon={<AlertCircle size={28} />}
        title={t("errorBoundary.routeTitle")}
        message={t("errorBoundary.routeBody")}
        action={
          <>
            <Button
              type="button"
              variant="primary"
              onClick={() => props.reset()}
            >
              {t("common.retry")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => window.location.reload()}
            >
              {t("errorBoundary.reload")}
            </Button>
          </>
        }
      />
    </div>
  );
}

export default function RouteErrorBoundary(props: {
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <SolidErrorBoundary
      fallback={(error, reset) => {
        // Diagnostics only; the visible copy stays generic.
        console.error("[dashboard] Page render error", error);
        return <RouteErrorFallback error={error} reset={reset} />;
      }}
    >
      {props.children}
    </SolidErrorBoundary>
  );
}
