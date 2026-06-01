import { Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { LogOut, Monitor } from "lucide-solid";
import { createSignal, Show } from "solid-js";
import AppShell from "~/components/shell/AppShell";
import AuthGuard from "~/components/auth/AuthGuard";
import { clearSession } from "~/lib/session";

export default function Sessions() {
  return (
    <>
      <Title>Sessions — Takosumi</Title>
      <AuthGuard>{(session) => <Inner session={session} />}</AuthGuard>
    </>
  );
}

function Inner(props: { session: import("~/lib/session").SessionRecord }) {
  const nav = useNavigate();
  const [busy, setBusy] = createSignal(false);
  // In-app confirmation (replaces blocking native confirm()).
  const [confirming, setConfirming] = createSignal(false);

  const signOutThisBrowser = () => {
    setBusy(true);
    clearSession();
    nav("/sign-in");
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>Sessions</h1>
        <p class="page-sub">アクティブなブラウザセッションの管理。</p>
      </div>

      <section class="detail-section">
        <h2>
          <Monitor size={18} /> 現在のセッション
        </h2>
        <dl class="kv-list">
          <dt>Session ID</dt>
          <dd>
            <code>{props.session.sessionId}</code>
          </dd>
          <dt>Subject</dt>
          <dd>
            <code>{props.session.subject}</code>
          </dd>
          <dt>Provider</dt>
          <dd>{props.session.provider ?? "—"}</dd>
          <dt>Expires</dt>
          <dd>{new Date(props.session.expiresAt).toLocaleString("ja-JP")}</dd>
          <dt>User-Agent</dt>
          <dd class="muted">{navigator.userAgent}</dd>
        </dl>
        <Show
          when={confirming()}
          fallback={
            <button
              class="btn btn-danger"
              type="button"
              onClick={() => setConfirming(true)}
              disabled={busy()}
              style="margin-top: 16px;"
            >
              <LogOut size={16} /> このブラウザからサインアウト
            </button>
          }
        >
          <div class="revoke-confirm" style="margin-top: 16px;">
            <span class="muted">このブラウザからサインアウトしますか？</span>
            <button
              class="btn btn-danger btn-sm"
              type="button"
              onClick={signOutThisBrowser}
              disabled={busy()}
            >
              <LogOut size={14} /> サインアウト
            </button>
            <button
              class="btn btn-secondary btn-sm"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy()}
            >
              取消
            </button>
          </div>
        </Show>
      </section>

      <section class="detail-section">
        <h2>他デバイスのセッション</h2>
        <p class="muted">
          他デバイスのセッション一覧とリモートサインアウト (coming soon):
          現在この account-plane は subject ごとのセッション列挙 API
          を持たないため、ここで管理できるのは上記の現在のブラウザのみです。
        </p>
      </section>
    </AppShell>
  );
}
