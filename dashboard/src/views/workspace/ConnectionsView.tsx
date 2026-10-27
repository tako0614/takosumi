/**
 * 接続 (`/connections`) — one page for the behavior "connect my cloud". Each
 * connection shows which installed apps use it; connections are added with
 * the shared create form, tested, and removed with a confirmation that names
 * the affected apps (see tabs/ConnectionsTab.tsx).
 */
import "../../styles/account-views.css";
import { Show } from "solid-js";
import { Link2 } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import {
  createCurrentWorkspace,
  WorkspaceScopeNote,
} from "../account/lib/current-workspace.tsx";
import { currentWorkspaceId } from "../../lib/workspace-state.ts";
import { t } from "../../i18n/index.ts";
import { Button, EmptyState, PageHeader } from "../../components/ui/index.ts";
import ConnectionsTab from "./tabs/ConnectionsTab.tsx";

export default function ConnectionsView() {
  return <Page title={t("conn.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const currentWorkspace = createCurrentWorkspace();
  return (
    <div class="acct-page">
      <PageHeader title={t("conn.title")} subtitle={t("conn.subtitle")} />
      <WorkspaceScopeNote context={currentWorkspace} />
      <Show
        when={currentWorkspaceId() || null}
        keyed
        fallback={
          <EmptyState
            icon={<Link2 size={28} />}
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
        {(workspaceId) => <ConnectionsTab workspaceId={workspaceId} />}
      </Show>
      <p class="acct-footnote">{t("conn.footnote")}</p>
    </div>
  );
}
