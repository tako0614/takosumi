/**
 * Space settings (`/space/settings[/:tab]`) — everything that belongs to the
 * Space rather than to one app: general (display name / policy), members,
 * connections, billing, backups, output shares. Tabs are routes so deep links
 * and the backend's OAuth-callback redirect (`/connections?connected=1` →
 * `/space/settings/connections?connected=1`) work unchanged.
 */
import { Match, Show, Switch } from "solid-js";
import { Settings2 } from "lucide-solid";
import { useParams } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import type { SessionRecord } from "../account/lib/session.ts";
import { currentSpaceId } from "../control/space-state.ts";
import { t } from "../../i18n/index.ts";
import {
  EmptyState,
  PageHeader,
  Tabs,
} from "../../components/ui/index.ts";
import GeneralTab from "./tabs/GeneralTab.tsx";
import MembersTab from "./tabs/MembersTab.tsx";
import ConnectionsTab from "./tabs/ConnectionsTab.tsx";
import BillingTab from "./tabs/BillingTab.tsx";
import BackupsTab from "./tabs/BackupsTab.tsx";
import SharesTab from "./tabs/SharesTab.tsx";

type TabId =
  | "general"
  | "members"
  | "connections"
  | "billing"
  | "backups"
  | "shares";

export default function SpaceSettingsView() {
  return (
    <Page title={t("spaceSettings.title")}>
      {(session) => <Inner session={session} />}
    </Page>
  );
}

function Inner(props: { readonly session: SessionRecord }) {
  const params = useParams();
  const tab = (): TabId => {
    const raw = params.tab;
    return raw === "members" ||
        raw === "connections" ||
        raw === "billing" ||
        raw === "backups" ||
        raw === "shares"
      ? raw
      : "general";
  };
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);

  const tabItems = () => [
    { href: "/space/settings", label: t("spaceSettings.tab.general"), end: true },
    { href: "/space/settings/members", label: t("spaceSettings.tab.members") },
    {
      href: "/space/settings/connections",
      label: t("spaceSettings.tab.connections"),
    },
    { href: "/space/settings/billing", label: t("spaceSettings.tab.billing") },
    { href: "/space/settings/backups", label: t("spaceSettings.tab.backups") },
    { href: "/space/settings/shares", label: t("spaceSettings.tab.shares") },
  ];

  return (
    <AppShell>
      <PageHeader
        title={t("spaceSettings.title")}
        subtitle={t("spaceSettings.subtitle")}
      />
      <Tabs items={tabItems()} aria-label="Space settings sections" />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Settings2 size={28} />}
            title={t("space.select")}
            message={t("space.selectMessage")}
          />
        }
      >
        {(id) => (
          <div class="wa-stack">
            <Switch>
              <Match when={tab() === "general"}>
                <GeneralTab spaceId={id()} />
              </Match>
              <Match when={tab() === "members"}>
                <MembersTab spaceId={id()} session={props.session} />
              </Match>
              <Match when={tab() === "connections"}>
                <ConnectionsTab spaceId={id()} />
              </Match>
              <Match when={tab() === "billing"}>
                <BillingTab spaceId={id()} />
              </Match>
              <Match when={tab() === "backups"}>
                <BackupsTab spaceId={id()} />
              </Match>
              <Match when={tab() === "shares"}>
                <SharesTab spaceId={id()} />
              </Match>
            </Switch>
          </div>
        )}
      </Show>
    </AppShell>
  );
}
