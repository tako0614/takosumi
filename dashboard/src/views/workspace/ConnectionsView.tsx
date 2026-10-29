/** Personal cloud connections are a primary destination. */
import "../../styles/wave-c.css";
import "../../styles/account-views.css";
import Page from "../account/components/auth/Page.tsx";
import { PageHeader } from "../../components/ui/index.ts";
import { t } from "../../i18n/index.ts";
import ConnectionsTab from "./tabs/ConnectionsTab.tsx";

export default function ConnectionsView() {
  return (
    <Page title={t("nav.connections")}>
      {() => (
        <div>
          <PageHeader title={t("nav.connections")} />
          <ConnectionsTab />
        </div>
      )}
    </Page>
  );
}
