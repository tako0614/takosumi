import type { JSX } from "solid-js";
import SplatField from "./SplatField.tsx";

interface Props {
  /**
   * `shell` = low-opacity scattered splats behind the app-shell content.
   * `auth` = denser, higher-opacity splats behind the sign-in page.
   */
  density?: "shell" | "auth";
}

/**
 * Decorative blue/red ink backdrop. Wraps the ported deterministic <SplatField>
 * in an absolutely-positioned, aria-hidden, pointer-events:none layer that sits
 * BEHIND content (z-index:0). Used only on the shell backdrop, the auth page,
 * and empty states — never on dense data tables.
 *
 * The host element must be `position: relative` (the shell `.app-shell-content`
 * and `.auth-page` both are) so the backdrop fills it.
 */
export default function InkBackdrop(props: Props): JSX.Element {
  const auth = () => props.density === "auth";
  return (
    <div
      class={`ink-backdrop ${auth() ? "ink-backdrop-auth" : "ink-backdrop-shell"}`}
      aria-hidden="true"
    >
      <SplatField density={auth() ? "hero" : "section"} />
    </div>
  );
}
