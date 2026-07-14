/**
 * 設定 > 管理ツール — the relocated hosting-management catalog. Every surface
 * from the old console-flavored nav (services list, connections, run ledger,
 * dependency graph, audit history, workspace settings)
 * stays reachable from here; the primary nav no longer carries them.
 */
import { A } from "@solidjs/router";
import { ChevronRight, Puzzle } from "lucide-solid";
import { createResource, For, type JSX } from "solid-js";
import Page from "../account/components/auth/Page.tsx";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { MANAGE_DESTINATIONS } from "../account/components/shell/nav.ts";
import {
  loadPlatformContributions,
  platformContributionDescription,
  platformContributionLabel,
  platformContributionsForSlot,
} from "../../lib/platform-contributions.ts";
import { intlLocale, t } from "../../i18n/index.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";

function contributionHref(href: string): string {
  const workspaceId = currentWorkspaceId();
  if (!workspaceId) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
}

function Inner(): JSX.Element {
  const [contributions] = createResource(loadPlatformContributions);
  return (
    <div class="settings-view">
      <PageHeader
        eyebrow={t("nav.settings")}
        title={t("settings.manage.title")}
        subtitle={t("settings.manage.subtitle")}
      />
      <div class="settings-links">
        <For each={MANAGE_DESTINATIONS}>
          {(dest) => (
            <A href={dest.href} class="settings-link tg-card tg-card-hover">
              <span class="settings-link-icon" aria-hidden="true">
                <dest.icon size={20} />
              </span>
              <span class="settings-link-text">
                <span class="settings-link-title">{t(dest.labelKey)}</span>
                <span class="settings-link-desc">{t(dest.descriptionKey)}</span>
              </span>
              <ChevronRight
                size={16}
                class="settings-link-chev"
                aria-hidden="true"
              />
            </A>
          )}
        </For>
        <For
          each={platformContributionsForSlot(
            contributions(),
            "navigation.manage",
          )}
        >
          {(contribution) => (
            <a
              href={contributionHref(contribution.href)}
              class="settings-link tg-card tg-card-hover"
            >
              <span class="settings-link-icon" aria-hidden="true">
                <Puzzle size={20} />
              </span>
              <span class="settings-link-text">
                <span class="settings-link-title">
                  {platformContributionLabel(contribution, intlLocale())}
                </span>
                <span class="settings-link-desc">
                  {platformContributionDescription(
                    contribution,
                    intlLocale(),
                  ) ?? contribution.href}
                </span>
              </span>
              <ChevronRight
                size={16}
                class="settings-link-chev"
                aria-hidden="true"
              />
            </a>
          )}
        </For>
      </div>
    </div>
  );
}

export default function ManageView() {
  return <Page title={t("settings.manage.title")}>{() => <Inner />}</Page>;
}
