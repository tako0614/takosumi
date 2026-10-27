/**
 * Installed app page (`/workloads/:id`, and the old `/workloads/:id/:tab`
 * links). The page itself lives in views/app/AppManagePage.tsx so the install
 * page can show the same sections once an install completes.
 */
import { useParams } from "@solidjs/router";
import Page from "../account/components/auth/Page.tsx";
import { t } from "../../i18n/index.ts";
import AppManagePage from "../app/AppManagePage.tsx";

export default function WorkloadDetailView() {
  const params = useParams();
  return (
    <Page title={t("app.pageTitle")}>
      {(session) => (
        <AppManagePage
          capsuleId={params.id ?? ""}
          principalId={session.subject}
          tab={params.tab}
        />
      )}
    </Page>
  );
}
