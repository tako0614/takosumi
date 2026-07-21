/**
 * Opt-in registration of this browser as the handler for the
 * `web+takosumi:` install scheme, so a store's "Get" button (which navigates to
 * `web+takosumi:install?…`) is routed to THIS Takosumi and lands on the
 * prefill-only `/new` flow. Canonical scheme spec: docs/integration/remote-install.md.
 *
 * The browser owns the real registration/permission state and there is no API
 * to read it back, so `installHandlerRegistered()` is only a best-effort
 * localStorage heuristic for reflecting the button state across reloads.
 */
import {
  TAKOSUMI_APP_INSTALL_HANDLER_TEMPLATE,
  TAKOSUMI_APP_INSTALL_SCHEME,
} from "takosumi-contract";

const STORAGE_KEY = "tsm.installHandlerRegistered";

export function installHandlerSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.registerProtocolHandler === "function"
  );
}

/** Best-effort: whether this browser was previously registered from here. */
export function installHandlerRegistered(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Register this browser for the `web+takosumi:` scheme. Must be called from a
 * user gesture (the browser shows a permission prompt). Throws if unsupported or
 * refused; the caller reflects failure without changing UI state.
 */
export function registerInstallHandler(): void {
  if (!installHandlerSupported()) {
    throw new Error("registerProtocolHandler is not supported");
  }
  navigator.registerProtocolHandler(
    TAKOSUMI_APP_INSTALL_SCHEME,
    TAKOSUMI_APP_INSTALL_HANDLER_TEMPLATE,
  );
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Private mode / storage disabled — the browser still owns the real
    // registration; only the local heuristic is unavailable.
  }
}
