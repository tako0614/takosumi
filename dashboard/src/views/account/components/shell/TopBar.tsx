/**
 * TopBar — chrome over the content well: the current section title on the left;
 * [bell + needs-attention badge] [profile menu] on the right. Brand and primary
 * nav live in the sidebar; this bar names where you are (important on mobile,
 * where the sidebar is hidden) and carries the global notifications / account
 * affordances (the profile avatar opens account, activity, and preferences).
 * Adding an app is owned by the store tab (shared nav model in `nav.ts`).
 * The bell badge shows the SAME 要対応 count as /notifications: both derive
 * from the shared cross-Workspace feed snapshot in lib/notifications.ts
 * (refreshed on navigation, TTL-throttled), scoped to the CURRENT Workspace,
 * so the numbers can never disagree, the badge persists on views that fetch
 * nothing else, and a Workspace switch never leaves the previous Workspace's
 * count on the bell.
 */
import { A, useLocation } from "@solidjs/router";
import { createEffect, createMemo, Show } from "solid-js";
import { Bell } from "lucide-solid";
import UserMenu from "../auth/UserMenu.tsx";
import WorkspaceSwitcher from "./WorkspaceSwitcher.tsx";
import { SECTION_TITLES } from "./nav.ts";
import {
  attentionCount,
  notificationFeed,
  refreshNotificationFeed,
} from "../../../../lib/notifications.ts";
import { currentWorkspaceId } from "../../../../lib/workspace-state.ts";
import { t } from "../../../../i18n/index.ts";

export default function TopBar() {
  const loc = useLocation();
  const sectionTitle = () => {
    const hit = SECTION_TITLES.find(([re]) => re.test(loc.pathname));
    return hit ? t(hit[1]) : "";
  };

  // Refresh the shared feed snapshot on every navigation (TTL-throttled in
  // lib/notifications.ts — no polling loop). Errors are non-fatal for the
  // chrome: the badge simply keeps its last known count.
  createEffect(() => {
    void loc.pathname;
    void refreshNotificationFeed().catch(() => {});
  });
  const badge = createMemo(() =>
    attentionCount(notificationFeed(), currentWorkspaceId() || undefined),
  );

  return (
    <header class="topbar">
      <Show when={sectionTitle()}>
        {(title) => <span class="topbar-title">{title()}</span>}
      </Show>
      <div class="topbar-mobile-workspace">
        <WorkspaceSwitcher compact />
      </div>
      <div class="topbar-actions">
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
    </header>
  );
}
