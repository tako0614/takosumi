/** Account profile, personal connections and personal usage. */
import "../../styles/wave-b.css";
import "../../styles/wave-c.css";
import "../../styles/account-views.css";
import { Match, Show, Switch } from "solid-js";
import { Navigate, useParams } from "@solidjs/router";
import Page from "./components/auth/Page.tsx";
import type { SessionRecord } from "./lib/session.ts";
import ProfileSection from "./sections/ProfileSection.tsx";
import TakosumiApiKeysCard from "./components/TakosumiApiKeysCard.tsx";
import ConnectionsTab from "../workspace/tabs/ConnectionsTab.tsx";
import BillingTab from "../workspace/tabs/BillingTab.tsx";
import { type MessageKey, t } from "../../i18n/index.ts";
import { PageHeader, Tabs } from "../../components/ui/index.ts";

export type AccountSection = "me" | "connections" | "usage" | "cli";

export const ACCOUNT_SECTIONS: readonly {
  readonly id: AccountSection;
  readonly href: string;
  readonly labelKey: MessageKey;
}[] = [
  { id: "me", href: "/account", labelKey: "account.section.me" },
  { id: "connections", href: "/account/connections", labelKey: "account.section.connections" },
  { id: "usage", href: "/account/usage", labelKey: "account.section.usage" },
  { id: "cli", href: "/account/cli", labelKey: "account.section.cli" },
];

function sectionFromParam(raw: string | undefined): AccountSection | undefined {
  if (raw === undefined || raw === "") return "me";
  return ACCOUNT_SECTIONS.find((section) => section.id === raw && raw !== "me")?.id;
}

export default function AccountView() {
  return (
    <Page title={t("account.title")}>
      {(session) => <Inner session={session} />}
    </Page>
  );
}

function Inner(props: { readonly session: SessionRecord }) {
  const params = useParams<{ section?: string }>();
  const section = () => sectionFromParam(params.section);

  return (
    <Show when={section()} fallback={<Navigate href="/account" />}>
      {(current) => (
        <div class="acct-page">
          <PageHeader title={t("account.title")} />
          <Tabs
            class="acct-tabs"
            items={ACCOUNT_SECTIONS.map((item) => ({
              href: item.href,
              label: t(item.labelKey),
              end: true,
            }))}
            aria-label={t("account.sectionsLabel")}
          />
          <div class="acct-section">
            <Switch>
              <Match when={current() === "me"}>
                <ProfileSection session={props.session} />
              </Match>
              <Match when={current() === "connections"}>
                <ConnectionsTab />
              </Match>
              <Match when={current() === "usage"}>
                <BillingTab />
              </Match>
              <Match when={current() === "cli"}>
                <TakosumiApiKeysCard />
              </Match>
            </Switch>
          </div>
        </div>
      )}
    </Show>
  );
}
