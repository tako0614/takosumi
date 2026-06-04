import Page from "~/components/auth/Page";
import InstallWizard from "~/components/apps/InstallWizard";

// In-dashboard install entry (the "+ Install" button). Renders the same
// wizard as the canonical /install route. Kept so existing /apps/install
// links/bookmarks keep working.
export default function Install() {
  return <Page title="Install app">{() => <InstallWizard />}</Page>;
}
