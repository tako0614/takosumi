/** Product navigation, notifications and the current account. */
import { A, useLocation } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { Bell } from "lucide-solid";
import UserMenu from "../auth/UserMenu.tsx";
import WorkspaceSwitcher from "./WorkspaceSwitcher.tsx";
import PrimaryNavigation from "./Sidebar.tsx";
import {
  attentionCount,
  notificationFeed,
  onNotificationsAcknowledged,
  refreshNotificationFeed,
  refreshWorkspaceNotificationFeed,
  workspaceNotificationFeed,
} from "../../../../lib/notifications.ts";
import { appOwnershipAvailable } from "../../../../lib/control-api.ts";
import { currentWorkspaceId } from "../../../../lib/workspace-state.ts";
import { t } from "../../../../i18n/index.ts";

export default function TopBar() {
  const loc = useLocation();
  const [personalApps] = createResource(() => appOwnershipAvailable());
  const appNotifications = () => !personalApps.error && personalApps() === true;
  const legacyNotifications = () => !personalApps.error && personalApps() === false;
  // Refresh the app feed (or the legacy selected Workspace) on navigation,
  // TTL-throttled in lib/notifications.ts. Errors are non-fatal for chrome:
  // the badge simply keeps its last known count.
  createEffect(() => {
    void loc.pathname;
    if (appNotifications()) {
      void refreshNotificationFeed().catch(() => {});
      return;
    }
    const workspaceId = legacyNotifications() ? currentWorkspaceId() : "";
    if (!workspaceId) return;
    void refreshWorkspaceNotificationFeed(workspaceId).catch(() => {});
  });
  // The acknowledged-at mark lives in localStorage, outside the reactive
  // graph — bump a tick so the badge clears the moment "mark all read" runs.
  const [ackTick, setAckTick] = createSignal(0);
  onCleanup(onNotificationsAcknowledged(() => setAckTick((n) => n + 1)));
  const badge = createMemo(() => {
    void ackTick();
    if (appNotifications()) return attentionCount(notificationFeed());
    const workspaceId = legacyNotifications() ? currentWorkspaceId() : "";
    if (!workspaceId) return 0;
    return attentionCount(workspaceNotificationFeed(workspaceId), workspaceId);
  });

  return (
    <header class="topbar">
      <div class="topbar-inner">
        <PrimaryNavigation />
        <div class="topbar-actions">
          <WorkspaceSwitcher />
          <A
            href="/notifications"
            class="topbar-icon-btn topbar-bell"
            aria-label={
              badge() > 0
                ? t("shell.notificationsAria", { n: badge() })
                : t("nav.notifications")
            }
          >
            <Bell size={18} />
            <Show when={badge() > 0}>
              <span class="topbar-badge" aria-hidden="true">
                {badge() > 9 ? "9+" : badge()}
              </span>
            </Show>
          </A>
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
