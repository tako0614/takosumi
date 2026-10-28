/**
 * The installed app's page, at its canonical URL `/apps/:id`. Older app URLs
 * (`/workloads/:id[/:tab]`, `/services/:id`, `/capsules/:id`, `/new?capsule=`)
 * redirect here; their tab becomes a section fragment (`#settings`,
 * `#history`, `#danger` …) that the page scrolls to once it has loaded. The
 * page itself lives in AppManagePage so the install page can show the same
 * sections once an install completes.
 */
import { Show } from "solid-js";
import { useLocation, useParams } from "@solidjs/router";
import Page from "../account/components/auth/Page.tsx";
import { t } from "../../i18n/index.ts";
import { appPageSectionFromHash } from "../../lib/app-links.ts";
import AppManagePage from "./AppManagePage.tsx";

export default function AppPage() {
  const params = useParams();
  const location = useLocation();
  const section = () => appPageSectionFromHash(location.hash);
  return (
    <Page title={t("app.pageTitle")}>
      {(session) => (
        // Keyed by app: following a link to another app (linked apps, the
        // uninstall impact list) mounts a fresh page, so no review, notice
        // or read of the previous app can show under the next one.
        <Show when={params.id ?? ""} keyed>
          {(capsuleId) => (
            <AppManagePage
              capsuleId={capsuleId}
              principalId={session.subject}
              {...(section() ? { section: section()! } : {})}
            />
          )}
        </Show>
      )}
    </Page>
  );
}
