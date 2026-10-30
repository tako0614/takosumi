/**
 * The installed app's page, at its canonical URL `/apps/:id`. Older app URLs
 * (`/workloads/:id[/:tab]`, `/services/:id`, `/capsules/:id`, `/new?capsule=`)
 * redirect here; their tab becomes a section fragment (`#settings`,
 * `#history`, `#danger` …) that the page scrolls to once it has loaded.
 * `?open=<interface>#phone` opens one screen's chooser (how it opens on a
 * phone); Android comes back there with `&missing=1` when the native app did
 * not open. The page itself lives in AppManagePage so the install page can
 * show the same sections once an install completes.
 */
import { Show } from "solid-js";
import { useLocation, useParams } from "@solidjs/router";
import Page from "../account/components/auth/Page.tsx";
import { t } from "../../i18n/index.ts";
import { appPageSectionFromHash } from "../../lib/app-links.ts";
import { parseOpenChooserQuery } from "../../lib/open-routing.ts";
import AppManagePage from "./AppManagePage.tsx";

export default function AppPage() {
  const params = useParams();
  const location = useLocation();
  const section = () => appPageSectionFromHash(location.hash);
  /** `?open=<interface>[&missing=1]`: a screen's chooser (lib/open-routing.ts). */
  const openChooser = () => parseOpenChooserQuery(location.search);
  return (
    <Page title={t("app.pageTitle")}>
      {(session) => (
        // Keyed by app so no review, notice or read of the previous app can
        // show under the next one.
        <Show when={params.id ?? ""} keyed>
          {(capsuleId) => (
            <AppManagePage
              capsuleId={capsuleId}
              principalId={session.subject}
              accountId={session.primaryAccountId ?? session.subject}
              {...(section() ? { section: section()! } : {})}
              openChooser={openChooser()}
            />
          )}
        </Show>
      )}
    </Page>
  );
}
