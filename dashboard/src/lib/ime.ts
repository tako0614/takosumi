/**
 * IME safety for keyboard shortcuts.
 *
 * Japanese (and other IME) input confirms a conversion with Enter and cancels
 * one with Escape. Those keydowns must not also commit a field, submit a step,
 * or dismiss a dialog. Chrome and Firefox flag them with `isComposing`; Safari
 * delivers the confirming keydown after `compositionend` and only marks it
 * with the legacy `keyCode` 229, so both checks are needed.
 */
export function isImeComposing(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return event.isComposing || event.keyCode === 229;
}
