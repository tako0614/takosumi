/**
 * 設定 hub — the third primary tab. Everyday items (account, plan & billing,
 * notifications) lead; the hosting-management catalog is one clearly-labeled
 * entry at the bottom (`/settings/manage`). Nothing was removed from the old
 * console IA — advanced surfaces are relocated behind that entry.
 */
import { A } from "@solidjs/router";
import { Bell, ChevronRight, CreditCard, UserCircle2, Wrench } from "lucide-solid";
import type { JSX } from "solid-js";
import Page from "../account/components/auth/Page.tsx";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { t } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/index.ts";

type SettingsLink = {
  readonly href: string;
  readonly titleKey: MessageKey;
  readonly descKey: MessageKey;
  readonly icon: typeof UserCircle2;
};

const GENERAL: readonly SettingsLink[] = [
  {
    href: "/settings/account",
    titleKey: "settings.account.title",
    descKey: "settings.account.desc",
    icon: UserCircle2,
  },
  {
    href: "/settings/billing",
    titleKey: "settings.billing.title",
    descKey: "settings.billing.desc",
    icon: CreditCard,
  },
  {
    href: "/notifications",
    titleKey: "settings.notifications.title",
    descKey: "settings.notifications.desc",
    icon: Bell,
  },
];

function LinkRow(props: { readonly link: SettingsLink }): JSX.Element {
  return (
    <A href={props.link.href} class="settings-link tg-card tg-card-hover">
      <span class="settings-link-icon" aria-hidden="true">
        <props.link.icon size={20} />
      </span>
      <span class="settings-link-text">
        <span class="settings-link-title">{t(props.link.titleKey)}</span>
        <span class="settings-link-desc">{t(props.link.descKey)}</span>
      </span>
      <ChevronRight size={16} class="settings-link-chev" aria-hidden="true" />
    </A>
  );
}

function Inner(): JSX.Element {
  return (
    <div class="settings-view">
      <PageHeader
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
      />
      <section
        class="settings-group"
        aria-label={t("settings.section.general")}
      >
        <h2 class="settings-group-title">{t("settings.section.general")}</h2>
        <div class="settings-links">
          {GENERAL.map((link) => (
            <LinkRow link={link} />
          ))}
        </div>
      </section>
      <section
        class="settings-group"
        aria-label={t("settings.section.advanced")}
      >
        <h2 class="settings-group-title">{t("settings.section.advanced")}</h2>
        <div class="settings-links">
          <LinkRow
            link={{
              href: "/settings/manage",
              titleKey: "settings.manage.entry",
              descKey: "settings.manage.entryDesc",
              icon: Wrench,
            }}
          />
        </div>
      </section>
    </div>
  );
}

export default function SettingsView() {
  return <Page title={t("settings.title")}>{() => <Inner />}</Page>;
}
