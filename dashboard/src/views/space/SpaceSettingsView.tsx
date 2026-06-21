/**
 * Advanced Workspace settings (`/advanced/workspace[/:tab]`) and standalone
 * normal-user surfaces (`/connections`, `/billing`). The standalone surfaces reuse the same
 * tab implementations but do not present them as "Workspace settings"; the full
 * tabbed view remains for advanced and legacy routes.
 */
import "../../styles/wave-a.css";
import { Match, Show, Switch } from "solid-js";
import { Settings2 } from "lucide-solid";
import { useParams } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import type { SessionRecord } from "../account/lib/session.ts";
import { currentSpaceId } from "../../lib/space-state.ts";
import { isTakosumiCloudRuntime } from "../../lib/deployment-brand.ts";
import { t } from "../../i18n/index.ts";
import { EmptyState, PageHeader, Tabs } from "../../components/ui/index.ts";
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

type StandaloneTabId = Extract<TabId, "connections" | "billing">;

interface SpaceSettingsViewProps {
  readonly standaloneTab?: StandaloneTabId;
}

export default function SpaceSettingsView(props: SpaceSettingsViewProps = {}) {
  return (
    <Page title={pageTitle(props.standaloneTab)}>
      {(session) => (
        <Inner session={session} standaloneTab={props.standaloneTab} />
      )}
    </Page>
  );
}

function Inner(props: {
  readonly session: SessionRecord;
  readonly standaloneTab?: StandaloneTabId;
}) {
  const params = useParams();
  const tab = (): TabId => {
    if (props.standaloneTab) return props.standaloneTab;
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
    {
      href: "/advanced/workspace",
      label: t("spaceSettings.tab.general"),
      end: true,
    },
    {
      href: "/advanced/workspace/members",
      label: t("spaceSettings.tab.members"),
    },
    {
      href: "/advanced/workspace/connections",
      label: t("spaceSettings.tab.connections"),
    },
    {
      href: "/advanced/workspace/billing",
      label: isTakosumiCloudRuntime()
        ? t("spaceSettings.tab.billing")
        : t("spaceSettings.tab.usageQuota"),
    },
  ];

  return (
    <AppShell>
      <PageHeader
        title={pageTitle(props.standaloneTab)}
        subtitle={pageSubtitle(props.standaloneTab)}
      />
      <Show when={!props.standaloneTab}>
        <Tabs items={tabItems()} aria-label="Workspace settings sections" />
      </Show>

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
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

function pageTitle(tab: StandaloneTabId | undefined): string {
  switch (tab) {
    case "connections":
      return t("conn.providerConnections.title");
    case "billing":
      return isTakosumiCloudRuntime()
        ? t("billing.title")
        : t("billing.usageQuotaTitle");
    default:
      return t("spaceSettings.title");
  }
}

function pageSubtitle(tab: StandaloneTabId | undefined): string {
  switch (tab) {
    case "connections":
      return t("conn.subtitle");
    case "billing":
      return isTakosumiCloudRuntime()
        ? t("billing.subtitle")
        : t("billing.usageQuotaSubtitle");
    default:
      return t("spaceSettings.subtitle");
  }
}
