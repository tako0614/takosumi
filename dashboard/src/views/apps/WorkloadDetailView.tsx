/**
 * Installed app page (`/workloads/:id`, and the old `/workloads/:id/:tab`
 * links). The page itself lives in views/app/AppManagePage.tsx so the install
 * page can show the same sections once an install completes.
 */
import { Show } from "solid-js";
import { useParams } from "@solidjs/router";
import Page from "../account/components/auth/Page.tsx";
import { t } from "../../i18n/index.ts";
import AppManagePage from "../app/AppManagePage.tsx";

export default function WorkloadDetailView() {
  const params = useParams();
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
              tab={params.tab}
            />
          )}
        </Show>
      )}
    </Page>
  );
}
