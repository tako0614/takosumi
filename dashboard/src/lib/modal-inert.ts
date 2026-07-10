/**
 * Make everything behind a modal overlay inert so assistive tech and Tab
 * cannot reach the backgrounded app while a dialog/drawer is open.
 *
 * The overlays are rendered inside the app tree (not portaled), so a single
 * `inert` on the app root would inert the dialog too. Instead this walks from
 * the overlay up to the `.app-shell` root (or `document.body` when the
 * dashboard is embedded without the shell chrome) and inerts every element
 * sibling along the way, leaving only the overlay's own ancestor chain live.
 *
 * Returns a restore function that removes only the attributes this call
 * added — a subtree that was already inert stays inert.
 */
export function inertBackground(overlay: HTMLElement): () => void {
  const stop = overlay.closest(".app-shell") ?? document.body;
  const made: Element[] = [];
  let node: HTMLElement = overlay;
  while (node.parentElement) {
    const parent = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      made.push(sibling);
    }
    if (parent === stop || parent === document.body) break;
    node = parent;
  }
  return () => {
    for (const el of made) el.removeAttribute("inert");
  };
}
