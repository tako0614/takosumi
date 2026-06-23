/**
 * TopBar — actions over the content well: [+ add] [bell + needs-attention badge]
 * [profile menu]. Brand and primary nav live in the sidebar; this bar carries
 * the create / notifications / account affordances. The bell badge counts
 * services needing attention in the current Workspace.
 */
import { A } from "@solidjs/router";
import { createMemo, createResource, Show } from "solid-js";
import { Bell, Plus } from "lucide-solid";
import UserMenu from "../auth/UserMenu.tsx";
import { currentSpaceId } from "../../../../lib/space-state.ts";
import {
  type Installation,
  listInstallations,
} from "../../../../lib/control-api.ts";
import {
  isVisibleServiceInstallation,
  needsAttention,
} from "../../../../lib/installations-ui.ts";
import { t } from "../../../../i18n/index.ts";

export default function TopBar() {
  const [installations] = createResource(
    () => currentSpaceId() || null,
    async (spaceId): Promise<readonly Installation[]> =>
      spaceId ? listInstallations(spaceId) : [],
  );
  const badge = createMemo(() => {
    const list = installations();
    if (!list) return 0;
    return list.filter(
      (inst) => isVisibleServiceInstallation(inst) && needsAttention(inst),
    ).length;
  });

  return (
    <header class="topbar">
      <div class="topbar-actions">
        <A
          href="/new"
          class="topbar-icon-btn topbar-add"
          aria-label={t("nav.add")}
        >
          <Plus size={18} />
        </A>
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
