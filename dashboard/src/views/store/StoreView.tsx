/**
 * ストア — the primary discovery tab. Wraps the shared StoreBrowser with the
 * decentralized Takosumi store(s). [追加] hands the listing to the one install
 * flow (`/new?…&auto=1`), which auto-starts when nothing needs the user's
 * input. Whether installation can start without user configuration is decided
 * by the install flow against the real repository-owned metadata. This says
 * nothing about build or deploy duration: the Store feed strips the input
 * schema and makes no client-side readiness or speed claim.
 */
import { onMount } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import Page from "../account/components/auth/Page.tsx";
import PageHeader from "../../components/ui/PageHeader.tsx";
import { locale, t } from "../../i18n/index.ts";
import {
  currentWorkspaceId,
  selectAvailableWorkspaceId,
  setCurrentWorkspaceId,
} from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import { StoreBrowser } from "./StoreBrowser.tsx";
import { buildNewQuery } from "./store-link.ts";
import type { TcsListing } from "../../lib/tcs-client.ts";

function Inner() {
  const navigate = useNavigate();

  onMount(async () => {
    if (currentWorkspaceId()) return;
    try {
      const workspaces = await listWorkspacesCached();
      const chosen = selectAvailableWorkspaceId(
        currentWorkspaceId(),
        workspaces,
      );
      if (chosen) setCurrentWorkspaceId(chosen);
    } catch {
      /* a workspace picker in the chrome handles the empty case */
    }
  });

  const onConfigure = (listing: TcsListing) => {
    navigate(`/new?${buildNewQuery(listing)}&auto=1`);
  };

  return (
    <div class="store-view">
      <PageHeader title={t("store.title")} subtitle={t("store.subtitle")} />
      <StoreBrowser
        locale={locale()}
        onConfigure={onConfigure}
        showSourceControls={false}
      />
      {/* The only in-app path to the manual Git-URL install + custom
          store-server management (blank /new). Without this, those surfaces are
          reachable only via external /install links. */}
      <p class="store-manual-entry">
        <A href="/new">{t("store.manualEntry")}</A>
      </p>
    </div>
  );
}

export default function StoreView() {
  return <Page title={t("store.title")}>{() => <Inner />}</Page>;
}
