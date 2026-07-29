/**
 * The `aria-modal` contract, in one place.
 *
 * While open: the backgrounded app is inert, focus moves INTO the dialog (so
 * Escape and Tab actually reach it), Tab cycles inside, Escape dismisses, and
 * focus returns to whatever was focused before.
 *
 * The confirm dialog and the store's detail drawer each hand-rolled this, and
 * they diverged on the part that matters — the confirm dialog only collected
 * `button` as focusable, so the first link or input added to it would have let
 * Tab escape to the inert page behind. One selector, one order, one cleanup.
 */
import { inertBackground } from "./modal-inert.ts";

/** Everything that can hold focus inside a dialog. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export interface ModalDialogOptions {
  /** The overlay; everything outside its ancestor chain becomes inert. */
  readonly overlay: () => HTMLElement | undefined;
  /** The focus scope — the dialog card/drawer itself. */
  readonly surface: () => HTMLElement | undefined;
  /** Focused on open. Defaults to the surface (which needs tabindex="-1"). */
  readonly initialFocus?: () => HTMLElement | undefined;
  /** Escape, and (when the caller wires it) an overlay click. */
  readonly onDismiss: () => void;
}

/**
 * Open a modal dialog. Call once the nodes are mounted; the returned function
 * closes it (remove the listener, un-inert, restore focus) and must run on
 * cleanup.
 */
export function openModalDialog(options: ModalDialogOptions): () => void {
  const previous =
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null;
  const overlay = options.overlay();
  const restoreInert = overlay ? inertBackground(overlay) : undefined;
  queueMicrotask(() =>
    (options.initialFocus?.() ?? options.surface())?.focus(),
  );

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      options.onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const surface = options.surface();
    if (!surface) return;
    // Only currently-visible controls count — a collapsed <details> holds
    // focusable children that Tab must skip.
    const focusables = Array.from(
      surface.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((el) => el.offsetParent !== null);
    const active = document.activeElement as HTMLElement | null;
    if (focusables.length === 0) {
      event.preventDefault();
      surface.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && (active === first || active === surface)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("keydown", onKeyDown);
  }
  return () => {
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", onKeyDown);
    }
    // Restore before refocusing: an inert element refuses focus.
    restoreInert?.();
    previous?.focus?.();
  };
}
