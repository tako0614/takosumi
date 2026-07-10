/**
 * Advanced Workspace settings (`/advanced/workspace[/:tab]`) and standalone
 * normal-user surfaces (`/connections`, `/billing`). The standalone surfaces reuse the same
 * tab implementations but do not present them as "Workspace settings"; the full
 * tabbed view remains for advanced and legacy routes.
 */
import "../../styles/wave-a.css";
import { lazy, Match, Show, Switch } from "solid-js";
import { Settings2 } from "lucide-solid";
import { useParams } from "@solidjs/router";
import Page from "../account/components/auth/Page.tsx";
import type { SessionRecord } from "../account/lib/session.ts";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
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
  | "cloud"
  | "keys"
  | "backups"
  | "shares";

type StandaloneTabId = Extract<TabId, "connections" | "billing">;

const CloudResourcesPanel = lazy(() =>
  import("../cloud/CloudResourcesView.tsx").then((m) => ({
    default: m.CloudResourcesPanel,
  })),
);
const CloudApiKeysPanel = lazy(() =>
  import("../cloud/CloudResourcesView.tsx").then((m) => ({
    default: m.CloudApiKeysPanel,
  })),
);

interface WorkspaceSettingsViewProps {
  readonly standaloneTab?: StandaloneTabId;
}

export default function WorkspaceSettingsView(
  props: WorkspaceSettingsViewProps = {},
) {
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
      raw === "cloud" ||
      raw === "keys" ||
      raw === "backups" ||
      raw === "shares"
      ? raw
      : "general";
  };
  const workspaceId = () =>
    currentWorkspaceId() ? currentWorkspaceId() : null;

  const tabItems = () => [
    {
      href: "/advanced/workspace",
      label: t("workspaceSettings.tab.general"),
      end: true,
    },
    {
      href: "/advanced/workspace/members",
      label: t("workspaceSettings.tab.members"),
    },
    {
      href: "/advanced/workspace/connections",
      label: t("workspaceSettings.tab.connections"),
    },
    {
      href: "/advanced/workspace/billing",
      label: isTakosumiCloudRuntime()
        ? t("workspaceSettings.tab.billing")
        : t("workspaceSettings.tab.usageQuota"),
    },
    ...(isTakosumiCloudRuntime()
      ? [
          {
            href: "/advanced/workspace/cloud",
            label: t("workspaceSettings.tab.cloud"),
          },
          {
            href: "/advanced/workspace/keys",
            label: t("workspaceSettings.tab.keys"),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={pageTitle(props.standaloneTab)}
        subtitle={pageSubtitle(props.standaloneTab)}
      />
      <Show when={!props.standaloneTab}>
        <Tabs items={tabItems()} aria-label={t("workspaceSettings.tabsLabel")} />
      </Show>

      <Show
        when={workspaceId()}
        keyed
        fallback={
          <EmptyState
            icon={<Settings2 size={28} />}
            title={t("workspace.select")}
            message={t("workspace.selectMessage")}
          />
        }
      >
        {(id) => (
          <div class="wa-stack">
            <Switch>
              <Match when={tab() === "general"}>
                <GeneralTab workspaceId={id} />
              </Match>
              <Match when={tab() === "members"}>
                <MembersTab workspaceId={id} session={props.session} />
              </Match>
              <Match when={tab() === "connections"}>
                <ConnectionsTab workspaceId={id} />
              </Match>
              <Match when={tab() === "billing"}>
                <BillingTab workspaceId={id} />
              </Match>
              <Match when={tab() === "cloud"}>
                <CloudResourcesPanel showHeader={false} />
              </Match>
              <Match when={tab() === "keys"}>
                <CloudApiKeysPanel showHeader={false} />
              </Match>
              <Match when={tab() === "backups"}>
                <BackupsTab workspaceId={id} />
              </Match>
              <Match when={tab() === "shares"}>
                <SharesTab workspaceId={id} />
              </Match>
            </Switch>
          </div>
        )}
      </Show>
    </>
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
      return t("workspaceSettings.title");
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
      return t("workspaceSettings.subtitle");
  }
}
