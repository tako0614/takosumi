/**
 * TopBar — chrome over the content well: the current section title on the left;
 * [+ add (mobile only)] [bell + needs-attention badge] [profile menu] on the
 * right. Brand and primary nav live in the sidebar; this bar names where you
 * are (important on mobile, where the sidebar is hidden) and carries the global
 * create / notifications / account affordances. The bell badge counts services
 * needing attention in the current Workspace.
 */
import { A, useLocation } from "@solidjs/router";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Bell, Plus } from "lucide-solid";
import UserMenu from "../auth/UserMenu.tsx";
import WorkspaceSwitcher from "./WorkspaceSwitcher.tsx";
import { currentWorkspaceId } from "../../../../lib/workspace-state.ts";
import { peekCapsulesCached } from "../../../../lib/capsule-list.ts";
import {
  isVisibleServiceCapsule,
  needsAttention,
} from "../../../../lib/capsules-ui.ts";
import { type MessageKey, t } from "../../../../i18n/index.ts";

/** Section title shown in the top bar, by route. Detail routes show the
 * section they belong to (the item's own name stays in the page header). */
const SECTION_TITLES: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/^\/$/, "nav.apps"],
  [/^\/services(\/|$)/, "nav.services"],
  [/^\/new(\/|$)/, "nav.add"],
  [/^\/cloud(\/|$)/, "nav.cloudResources"],
  [/^\/connections(\/|$)/, "nav.connections"],
  [/^\/advanced\/workspace(\/|$)/, "nav.workspaceSettings"],
  [/^\/billing(\/|$)/, "nav.billing"],
  [/^\/runs(\/|$)/, "nav.runs"],
  [/^\/run-groups(\/|$)/, "nav.runs"],
  [/^\/notifications(\/|$)/, "nav.notifications"],
  [/^\/activity(\/|$)/, "nav.activity"],
  [/^\/account(\/|$)/, "nav.account"],
];

export default function TopBar() {
  const loc = useLocation();
  const sectionTitle = () => {
    const hit = SECTION_TITLES.find(([re]) => re.test(loc.pathname));
    return hit ? t(hit[1]) : "";
  };

  const [cacheVersion, setCacheVersion] = createSignal(0);
  if (typeof window !== "undefined") {
    const onCacheChanged = () => setCacheVersion((version) => version + 1);
    window.addEventListener("takosumi:capsules-cache-changed", onCacheChanged);
    onCleanup(() =>
      window.removeEventListener(
        "takosumi:capsules-cache-changed",
        onCacheChanged,
      ),
    );
  }
  const badge = createMemo(() => {
    cacheVersion();
    const workspaceId = currentWorkspaceId();
    const list = workspaceId
      ? peekCapsulesCached(workspaceId, { includeDestroyed: false })
      : undefined;
    if (!list) return 0;
    return list.filter(
      (inst) => isVisibleServiceCapsule(inst) && needsAttention(inst),
    ).length;
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
