/**
 * TopBar — chrome over the content well: the current section title on the left;
 * [bell + needs-attention badge] [profile menu] on the right. Brand and primary
 * nav live in the sidebar; this bar names where you are (important on mobile,
 * where the sidebar is hidden) and carries the global notifications / account
 * affordances (the profile avatar opens account, activity, and preferences).
 * Adding an app is owned by the store tab (shared nav model in `nav.ts`).
 * The bell badge and the /notifications 要対応 banner derive the same failure
 * count from lib/notifications.ts. The bell refresh is Workspace-scoped and
 * TTL-throttled: ordinary navigation never lists every Workspace or fans out
 * one Activity request per Workspace.
 */
import { A, useLocation } from "@solidjs/router";
import { createEffect, createMemo, Show } from "solid-js";
import { Bell } from "lucide-solid";
import UserMenu from "../auth/UserMenu.tsx";
import WorkspaceSwitcher from "./WorkspaceSwitcher.tsx";
import { SECTION_TITLES } from "./nav.ts";
import {
  attentionCount,
  refreshWorkspaceNotificationFeed,
  workspaceNotificationFeed,
} from "../../../../lib/notifications.ts";
import { currentWorkspaceId } from "../../../../lib/workspace-state.ts";
import { t } from "../../../../i18n/index.ts";

export default function TopBar() {
  const loc = useLocation();
  const sectionTitle = () => {
    const hit = SECTION_TITLES.find(([re]) => re.test(loc.pathname));
    return hit ? t(hit[1]) : "";
  };

  // Refresh exactly the selected Workspace on navigation (TTL-throttled in
  // lib/notifications.ts — no polling loop). Errors are non-fatal for chrome:
  // the badge simply keeps its last known count.
  createEffect(() => {
    void loc.pathname;
    const workspaceId = currentWorkspaceId();
    if (!workspaceId) return;
    void refreshWorkspaceNotificationFeed(workspaceId).catch(() => {});
  });
  const badge = createMemo(() => {
    const workspaceId = currentWorkspaceId();
    if (!workspaceId) return 0;
    return attentionCount(workspaceNotificationFeed(workspaceId), workspaceId);
  });

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
