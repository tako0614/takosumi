import type { JSX } from "solid-js";
import Sidebar from "./Sidebar.tsx";
import TopBar from "./TopBar.tsx";
import MobileTabs from "./MobileTabs.tsx";
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
 * Dashboard chrome: a persistent left sidebar (primary nav: home / cloud
 * accounts / settings) + a top bar (add / notifications / profile menu) over the
 * content well, with mobile bottom tabs. The home screen stays an app launcher;
 * the sidebar restores the wayfinding the chromeless shell had removed.
 */
export default function AppShell(props: Props) {
  return (
    <div class="app-shell">
      <a href="#main" class="skip-link">
        {t("shell.skipToContent")}
      </a>
      <Sidebar />
      <div class="app-shell-main">
        <TopBar />
        <main class="app-shell-content" id="main" tabindex="-1">
          {props.children}
        </main>
      </div>
      <MobileTabs />
      <ConfirmDialogRenderer />
    </div>
  );
}
