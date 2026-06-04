import AppShell from "~/components/shell/AppShell";
import Page from "~/components/auth/Page";

export default function Account() {
  return (
    <Page title="Account">
      {() => (
        <AppShell>
          <div class="page-header">
            <h1>Account</h1>
            <p class="page-sub">
              プロフィール、 セキュリティ、 トークン、 サブスクリプション。
            </p>
          </div>
          <div class="account-nav">
            <a href="/account/profile">プロフィール</a>
            <a href="/account/security">セキュリティ (passkey / 接続)</a>
            <a href="/account/tokens">Personal access tokens</a>
            <a href="/account/billing">Billing</a>
            <a href="/account/sessions">Sessions</a>
          </div>
        </AppShell>
      )}
    </Page>
  );
}
