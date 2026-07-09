/**
 * 設定 > 管理ツール — the relocated hosting-management catalog. Every surface
 * from the old console-flavored nav (services list, connections, cloud
 * resources, run ledger, dependency graph, audit history, workspace settings)
 * stays reachable from here; the primary nav no longer carries them.
 */
import { A } from "@solidjs/router";
import { ChevronRight } from "lucide-solid";
import { For, type JSX } from "solid-js";
import Page from "../account/components/auth/Page.tsx";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { MANAGE_DESTINATIONS } from "../account/components/shell/nav.ts";
import { t } from "../../i18n/index.ts";

function Inner(): JSX.Element {
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
                <span class="settings-link-desc">
                  {t(dest.descriptionKey)}
                </span>
              </span>
              <ChevronRight
                size={16}
                class="settings-link-chev"
                aria-hidden="true"
              />
            </A>
          )}
        </For>
      </div>
    </div>
  );
}

export default function ManageView() {
  return <Page title={t("settings.manage.title")}>{() => <Inner />}</Page>;
}
