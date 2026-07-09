/**
 * ストア — the primary discovery tab. Wraps the shared StoreBrowser with the
 * decentralized Takosumi store(s). [入手] hands the listing to the one install
 * flow (`/new?…&auto=1`), which auto-starts when nothing needs the user's
 * input; listings that install with zero typing carry a readiness badge
 * derived from the listing + the workspace's provider connections
 * (lib/install-readiness.ts).
 */
import { createMemo, createResource, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Page from "../account/components/auth/Page.tsx";
import { locale, t } from "../../i18n/index.ts";
import {
  currentWorkspaceId,
  selectAvailableWorkspaceId,
  setCurrentWorkspaceId,
} from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import { listProviderConnections } from "../../lib/control-api.ts";
import {
  deriveInstallReadiness,
  installReadinessContext,
} from "../../lib/install-readiness.ts";
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

  const [providerConnections] = createResource(
    () => currentWorkspaceId() || null,
    (workspaceId) => listProviderConnections(workspaceId).catch(() => []),
  );
  const readinessContext = createMemo(() =>
    installReadinessContext(providerConnections() ?? []),
  );
  const listingBadge = (listing: TcsListing): string | undefined =>
    deriveInstallReadiness(listing, readinessContext()) === "oneTap"
      ? t("store.badge.oneTap")
      : undefined;

  const onConfigure = (listing: TcsListing) => {
    navigate(`/new?${buildNewQuery(listing)}&auto=1`);
  };

  return (
    <div
      style={{
        "max-width": "1080px",
        margin: "0 auto",
        padding: "20px 24px 72px",
      }}
    >
      <header style={{ "margin-bottom": "18px" }}>
        <h1 style={{ margin: "0 0 4px" }}>{t("store.title")}</h1>
        <p style={{ margin: "0", color: "var(--tg-text-muted, #9aa0ad)" }}>
          {t("store.subtitle")}
        </p>
      </header>
      <StoreBrowser
        locale={locale()}
        onConfigure={onConfigure}
        listingBadge={listingBadge}
      />
    </div>
  );
}

export default function StoreView() {
  return <Page title={t("store.title")}>{() => <Inner />}</Page>;
}
