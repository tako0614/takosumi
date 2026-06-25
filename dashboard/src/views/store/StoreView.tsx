/**
 * Control-plane Store tab. Wraps the shared StoreBrowser with Takosumi's
 * official starter catalog and hands every add action to the full /new flow
 * where compatibility, provider connections, and variables are reviewed.
 */
import { createMemo, createResource, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { locale, t } from "../../i18n/index.ts";
import {
  currentSpaceId,
  selectAvailableSpaceId,
  setCurrentSpaceId,
} from "../../lib/space-state.ts";
import {
  listSpaces,
  listStarterCatalogInstallConfigs,
  type InstallConfig,
} from "../../lib/control-api.ts";
import { StoreBrowser } from "./StoreBrowser.tsx";
import { buildNewQuery } from "./store-link.ts";
import type { TcsListing } from "../../lib/tcs-client.ts";

type CatalogInstallConfig = InstallConfig & {
  readonly catalog: NonNullable<InstallConfig["catalog"]> & {
    readonly source: NonNullable<
      NonNullable<InstallConfig["catalog"]>["source"]
    >;
  };
};

function isCatalogInstallConfig(
  config: InstallConfig,
): config is CatalogInstallConfig {
  return Boolean(config.catalog?.source);
}

function asTcsListing(config: CatalogInstallConfig): TcsListing {
  const catalog = config.catalog;
  return {
    id: catalog.templateId ?? config.id,
    installConfigId: config.id,
    source: {
      git: catalog.source.git,
      ref: catalog.source.ref,
      path: catalog.source.path,
      ...(catalog.source.ref.match(/^[0-9a-f]{40}$/iu)
        ? { resolvedCommit: catalog.source.ref }
        : {}),
    },
    kind: catalog.kind,
    surface: catalog.surface,
    provider: catalog.provider,
    category: catalog.surface,
    suggestedName: catalog.suggestedName,
    name: catalog.name,
    description: catalog.description,
    badge: catalog.badge,
    inputs: catalog.inputs,
    outputAllowlist: [],
    publisher: { handle: "takosumi", displayName: "Takosumi" },
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function Inner() {
  const navigate = useNavigate();
  const workspaceId = () => currentSpaceId() || undefined;
  const [officialCatalog] = createResource(
    workspaceId,
    listStarterCatalogInstallConfigs,
  );
  const localListings = createMemo(() =>
    (officialCatalog() ?? []).filter(isCatalogInstallConfig).map(asTcsListing),
  );

  onMount(async () => {
    if (currentSpaceId()) return;
    try {
      const spaces = await listSpaces();
      const chosen = selectAvailableSpaceId(currentSpaceId(), spaces);
      if (chosen) setCurrentSpaceId(chosen);
    } catch {
      /* a workspace picker in the chrome handles the empty case */
    }
  });

  const onConfigure = (listing: TcsListing) => {
    navigate(`/new?${buildNewQuery(listing)}`);
  };

  return (
    <AppShell>
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
          localListings={localListings()}
          onInstall={onConfigure}
          onConfigure={onConfigure}
        />
      </div>
    </AppShell>
  );
}

export default function StoreView() {
  return <Page title={t("store.title")}>{() => <Inner />}</Page>;
}
