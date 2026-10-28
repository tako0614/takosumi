/**
 * アカウント (`/account[/:section]`) — the behavior "use Takosumi with others
 * and pay", plus you yourself. One page with five sections:
 *
 *   自分              (`/account`)            name, display and language, sign-out
 *   メンバー          (`/account/members`)    invite people, roles, display names
 *   料金と利用量      (`/account/billing`)    what this workspace costs and uses
 *   スペース          (`/account/workspace`)  this workspace's name, new
 *                                             workspaces by purpose
 *   CLI・APIから使う  (`/account/cli`)        keys for the CLI (`--token`) and API
 *
 * Members, billing and the workspace section are about the selected workspace
 * (スペース in the Japanese UI). The page names that workspace only when there
 * are two or more (lib: current-workspace.tsx); one person with one workspace
 * never has to learn the word.
 */
import "../../styles/wave-b.css";
import "../../styles/wave-c.css";
import "../../styles/account-views.css";
import { Match, Show, Switch, type JSX } from "solid-js";
import { Navigate, useParams } from "@solidjs/router";
import { Layers } from "lucide-solid";
import Page from "./components/auth/Page.tsx";
import type { SessionRecord } from "./lib/session.ts";
import { createCurrentWorkspace, WorkspaceScopeNote } from "./lib/current-workspace.tsx";
import ProfileSection from "./sections/ProfileSection.tsx";
import TakosumiApiKeysCard from "./components/TakosumiApiKeysCard.tsx";
import MembersTab from "../workspace/tabs/MembersTab.tsx";
import WorkspaceTab from "../workspace/tabs/WorkspaceTab.tsx";
import BillingTab from "../workspace/tabs/BillingTab.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { type MessageKey, t } from "../../i18n/index.ts";
import {
  Button,
  EmptyState,
  PageHeader,
  Tabs,
} from "../../components/ui/index.ts";

export type AccountSection = "me" | "members" | "billing" | "workspace" | "cli";

export const ACCOUNT_SECTIONS: readonly {
  readonly id: AccountSection;
  readonly href: string;
  readonly labelKey: MessageKey;
}[] = [
  { id: "me", href: "/account", labelKey: "account.section.me" },
  { id: "members", href: "/account/members", labelKey: "account.section.members" },
  { id: "billing", href: "/account/billing", labelKey: "account.section.billing" },
  { id: "workspace", href: "/account/workspace", labelKey: "account.section.workspace" },
  { id: "cli", href: "/account/cli", labelKey: "account.section.cli" },
];

function sectionFromParam(raw: string | undefined): AccountSection | undefined {
  if (raw === undefined || raw === "") return "me";
  return ACCOUNT_SECTIONS.find((section) => section.id === raw && raw !== "me")
    ?.id;
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
  const currentWorkspace = createCurrentWorkspace();

  /** Members, billing and the workspace need a selected workspace. */
  const inWorkspace = (render: (workspaceId: string) => JSX.Element) => (
    <>
      <WorkspaceScopeNote context={currentWorkspace} />
      <Show
        when={currentWorkspaceId() || null}
        keyed
        fallback={
          <EmptyState
            icon={<Layers size={28} />}
            title={t("workspace.noneTitle")}
            message={t("workspace.noneMessage")}
            action={
              <Button variant="primary" href="/">
                {t("workspace.noneCta")}
              </Button>
            }
          />
        }
      >
        {(workspaceId) => render(workspaceId)}
      </Show>
    </>
  );

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
              <Match when={current() === "members"}>
                {inWorkspace((workspaceId) => (
                  <MembersTab workspaceId={workspaceId} session={props.session} />
                ))}
              </Match>
              <Match when={current() === "billing"}>
                {inWorkspace((workspaceId) => <BillingTab workspaceId={workspaceId} />)}
              </Match>
              <Match when={current() === "workspace"}>
                {/* Creating a workspace by purpose works with no workspace yet. */}
                <WorkspaceScopeNote context={currentWorkspace} />
                <WorkspaceTab />
              </Match>
              <Match when={current() === "cli"}>
                <TakosumiApiKeysCard
                  workspaceId={currentWorkspaceId() || undefined}
                />
              </Match>
            </Switch>
          </div>
        </div>
      )}
    </Show>
  );
}
