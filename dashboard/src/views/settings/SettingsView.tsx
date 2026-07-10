/**
 * 設定 hub — the third primary tab. The plan & billing state leads (a live
 * summary strip with the current plan, payment status, and balance — billing
 * is a first-class consumer surface, not a buried tab), then the everyday
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
import { createMemo, createResource, Show, type JSX } from "solid-js";
import Page from "../account/components/auth/Page.tsx";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { Badge, Button, Card } from "../../components/ui/index.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { getWorkspaceBilling } from "../../lib/control-api.ts";
import { formatUsdMicros } from "../../lib/billing-format.ts";
import { isTakosumiCloudRuntime } from "../../lib/deployment-brand.ts";
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

/** Live plan & payment strip. Hidden on self-host with billing disabled and
 * no subscription — there is nothing to pay there. */
function BillingSummary(): JSX.Element {
  const [billing] = createResource(
    () => currentWorkspaceId() || undefined,
    getWorkspaceBilling,
  );
  const subscription = () => billing()?.subscription;
  const planName = () => billing()?.plan?.name;
  const balance = () => billing()?.balance;
  const availableUsdMicros = () => balance()?.availableUsdMicros ?? 0;
  // Any non-healthy subscription status needs attention + the recovery CTA —
  // not just past_due. A canceled/unpaid/incomplete sub must not read as a
  // healthy green badge.
  const NEEDS_ATTENTION_STATUSES: ReadonlySet<string> = new Set([
    "past_due",
    "unpaid",
    "canceled",
    "cancelled",
    "incomplete",
    "incomplete_expired",
  ]);
  const needsAttention = () => {
    const status = subscription()?.status;
    return status !== undefined && NEEDS_ATTENTION_STATUSES.has(status);
  };
  const visible = createMemo(
    () =>
      billing() !== undefined &&
      (isTakosumiCloudRuntime() ||
        (billing()?.settings?.mode ?? "disabled") !== "disabled" ||
        subscription() !== undefined),
  );
  const statusLabel = () => {
    const status = subscription()?.status;
    if (!status) return t("billing.balance.ready");
    const key = `billing.subscription.status.${status}` as MessageKey;
    return t(key) === key ? status : t(key);
  };
  return (
    <Show when={visible()}>
      <Card class="settings-billing-summary">
        <div class="settings-billing-row">
          <span class="settings-link-icon" aria-hidden="true">
            <CreditCard size={20} />
          </span>
          <div class="settings-link-text">
            <span class="settings-link-title">
              {planName() ?? t("settings.billingSummary.noPlan")}
              <Show when={subscription()}>
                <Badge tone={needsAttention() ? "danger" : "ok"}>
                  {statusLabel()}
                </Badge>
              </Show>
            </span>
            <span class="settings-link-desc">
              <Show
                when={availableUsdMicros() > 0}
                fallback={t("settings.billing.desc")}
              >
                {t("billing.balance.availableUsd")}:{" "}
                {formatUsdMicros(availableUsdMicros())}
              </Show>
            </span>
          </div>
          <Button
            variant={needsAttention() ? "primary" : "secondary"}
            href="/settings/billing"
          >
            {needsAttention()
              ? t("settings.billingSummary.fix")
              : t("settings.billingSummary.manage")}
          </Button>
        </div>
      </Card>
    </Show>
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
