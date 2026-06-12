/**
 * TopBar: [Space switcher] ......... [bell + needs-attention badge] [UserMenu].
 *
 * The bell badge counts unseen needs-attention events (run failures / drift /
 * revoked connections) across every Space, via the cached feed loader in
 * lib/notifications.ts (TTL-cached because each view mounts its own shell).
 * Opening /notifications marks the feed seen, which clears the badge reactively
 * through the shared `seenVersion` signal.
 */
import { A } from "@solidjs/router";
import { createMemo, createResource, Show } from "solid-js";
import { Bell } from "lucide-solid";
import UserMenu from "../auth/UserMenu.tsx";
import SpaceSwitcher from "./SpaceSwitcher.tsx";
import {
  loadFeedForBadge,
  seenVersion,
  unseenFailureCount,
} from "../../../../lib/notifications.ts";
import { t } from "../../../../i18n/index.ts";

export default function TopBar() {
  const [feed] = createResource(loadFeedForBadge);
  const badge = createMemo(() => {
    seenVersion(); // re-derive when the seen marker moves
    const list = feed();
    if (!list) return 0;
    return unseenFailureCount(list);
  });

  return (
    <header class="topbar">
      <SpaceSwitcher />
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
