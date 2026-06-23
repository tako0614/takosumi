import type { JSX } from "solid-js";
import TopBar from "./TopBar.tsx";
import { ConfirmDialogRenderer } from "../../../../components/ConfirmDialogRenderer.tsx";
import { t } from "../../../../i18n/index.ts";
// Dashboard design system (tokens → base → components → shell → views). Imported once
// here so every screen wrapped in <AppShell> gets the styles even when the
// dashboard is consumed via the in-process takos-web alias.
import "../../../../styles/tokens.css";
import "../../../../styles/base.css";
import "../../../../styles/components.css";
import "../../../../styles/shell.css";
import "../../../../styles/views.css";

interface Props {
  children: JSX.Element;
}

/**
 * App-home chrome: a single top bar (brand + add + notifications + profile menu)
 * over a full-width content well. No sidebar — the home-screen launcher and the
 * profile menu carry navigation, keeping the surface app-like, not admin-console.
 */
export default function AppShell(props: Props) {
  return (
    <div class="app-shell">
      <a href="#main" class="skip-link">
        {t("shell.skipToContent")}
      </a>
      <TopBar />
      <main class="app-shell-content" id="main" tabindex="-1">
        {props.children}
      </main>
      <ConfirmDialogRenderer />
    </div>
  );
}
