import type { JSX } from "solid-js";
import Sidebar from "./Sidebar.tsx";
import TopBar from "./TopBar.tsx";
import MobileTabs from "./MobileTabs.tsx";
import { ConfirmDialogRenderer } from "../../../../components/ConfirmDialogRenderer.tsx";
import InkBackdrop from "../../../../components/ui/InkBackdrop.tsx";
import { t } from "../../../../i18n/index.ts";
// Dark design system (tokens → base → components → shell → views). Imported once
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
 * Dashboard chrome: sidebar (primary nav) + topbar (Workspace switcher / bell /
 * user menu) + mobile tabs.
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
          <InkBackdrop density="shell" />
          {props.children}
        </main>
      </div>
      <MobileTabs />
      <ConfirmDialogRenderer />
    </div>
  );
}
