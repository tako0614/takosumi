/**
 * 設定 hub — the third primary tab. Provider-neutral usage/showback state can
 * lead when enabled, followed by the everyday
 * items (account, billing detail, notifications), then the hosting-management
 * catalog behind one clearly-labeled entry (`/settings/manage`). Nothing was
 * removed from the old console IA — advanced surfaces are relocated.
 */
import { A } from "@solidjs/router";
import {
  Bell,
  ChevronRight,
  CreditCard,
  UserCircle2,
  Wrench,
} from "lucide-solid";
import { createMemo, createResource, Match, Switch, type JSX } from "solid-js";
import Page from "../account/components/auth/Page.tsx";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { Button, Card } from "../../components/ui/index.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { getWorkspaceBilling } from "../../lib/control-api.ts";
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

/** Provider-neutral showback strip. Commercial state belongs to extensions. */
function BillingSummary(): JSX.Element {
  const [billing, { refetch: refetchBilling }] = createResource(
    () => currentWorkspaceId() || undefined,
    getWorkspaceBilling,
  );
  // A failed getWorkspaceBilling must not crash the whole /settings hub (a
  // primary nav tab): guard `billing.error` BEFORE reading `billing()`, whose
  // accessor THROWS while the resource is errored.
  const visible = createMemo(() => {
    if (billing.error) return false;
    const data = billing();
    return (
      data !== undefined && (data.settings?.mode ?? "disabled") !== "disabled"
    );
  });
  return (
    <Switch>
      <Match when={billing.error}>
        <Card class="settings-billing-summary">
          <div class="settings-billing-row">
            <span class="settings-link-icon" aria-hidden="true">
              <CreditCard size={20} />
            </span>
            <div class="settings-link-text">
              <span class="settings-link-title">
                {t("settings.billing.title")}
              </span>
              <span class="settings-link-desc">
                {t("settings.billingSummary.error")}
              </span>
            </div>
            <Button
              variant="secondary"
              type="button"
              onClick={() => void refetchBilling()}
            >
              {t("common.retry")}
            </Button>
          </div>
        </Card>
      </Match>
      <Match when={visible()}>
        <Card class="settings-billing-summary">
          <div class="settings-billing-row">
            <span class="settings-link-icon" aria-hidden="true">
              <CreditCard size={20} />
            </span>
            <div class="settings-link-text">
              <span class="settings-link-title">
                {t("settings.billing.title")}
              </span>
              <span class="settings-link-desc">
                {t("billing.mode.showback")}
              </span>
            </div>
            <Button variant="secondary" href="/settings/billing">
              {t("settings.billingSummary.manage")}
            </Button>
          </div>
        </Card>
      </Match>
    </Switch>
  );
}

function Inner(): JSX.Element {
  return (
    <div class="settings-view">
      <PageHeader
        title={t("settings.title")}
        subtitle={t("settings.subtitle")}
      />
      <BillingSummary />
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
