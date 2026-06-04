import AppShell from "~/components/shell/AppShell";
import Page from "~/components/auth/Page";

export default function Profile() {
  return (
    <Page title="プロフィール">
      {(session) => (
        <AppShell>
          <div class="page-header">
            <h1>プロフィール</h1>
            <p class="page-sub">現在のサインイン情報。</p>
          </div>
          <section class="detail-section">
            <dl class="kv-list">
              <dt>Subject</dt>
              <dd>
                <code>{session.subject}</code>
              </dd>
              <dt>Display name</dt>
              <dd>{session.displayName ?? "—"}</dd>
              <dt>Email</dt>
              <dd>{session.email ?? "—"}</dd>
              <dt>Provider</dt>
              <dd>{session.provider ?? "—"}</dd>
              <dt>Session expires</dt>
              <dd>{new Date(session.expiresAt).toLocaleString("ja-JP")}</dd>
            </dl>
          </section>
        </AppShell>
      )}
    </Page>
  );
}
