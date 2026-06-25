/**
 * Control-plane Store tab. Wraps the shared StoreBrowser with the decentralized
 * Takosumi store(s); every add action is handed to the full /new flow where
 * compatibility, provider connections, and variables are reviewed. There is no
 * built-in starter catalog here — discovery lives in the store.
 */
import { onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { locale, t } from "../../i18n/index.ts";
import {
  currentSpaceId,
  selectAvailableSpaceId,
  setCurrentSpaceId,
} from "../../lib/space-state.ts";
import { listSpaces } from "../../lib/control-api.ts";
import { StoreBrowser } from "./StoreBrowser.tsx";
import { buildNewQuery } from "./store-link.ts";
import type { TcsListing } from "../../lib/tcs-client.ts";

function Inner() {
  const navigate = useNavigate();

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
