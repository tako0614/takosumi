import { Bell } from "lucide-solid";
import AppShell from "~/components/shell/AppShell";
import Page from "~/components/auth/Page";

export default function Notifications() {
  return (
    <Page title="Notifications">
      {() => (
        <AppShell>
          <div class="page-header">
            <h1>Notifications</h1>
            <p class="page-sub">
              billing アラート / app install イベント / invite の通知。
            </p>
          </div>
          <section class="empty-state">
            <Bell size={32} aria-hidden="true" />
            <p>通知はまだ利用できません (coming soon)。</p>
            <p class="muted">
              billing アラート / app install イベント / invite
              の通知配信は、このアカウントプレーンではまだ実装されていません。
            </p>
          </section>
        </AppShell>
      )}
    </Page>
  );
}
