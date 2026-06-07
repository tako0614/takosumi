import {
  CreditCard,
  ExternalLink,
  LogOut,
  Monitor,
  Save,
  Settings,
} from "lucide-solid";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import AppShell from "./components/shell/AppShell.tsx";
import Page from "./components/auth/Page.tsx";
import { clearSession, type SessionRecord } from "./lib/session.ts";
import { rpc, ApiError } from "./lib/api.ts";
import {
  listSpaces,
  updateSpace,
  type PolicyConfig,
  type Space,
} from "../../lib/control-api.ts";
import { currentSpaceId, setCurrentSpaceId } from "../control/space-state.ts";

/**
 * Account hub + Profile + Sessions — three closely-coupled read-only
 * account-plane screens folded from the takosumi dashboard SPA:
 *   - AccountHubView   (dashboard-ui/src/routes/account/index.tsx)
 *   - AccountProfileView (dashboard-ui/src/routes/account/profile.tsx)
 *   - AccountSessionsView (dashboard-ui/src/routes/account/sessions.tsx)
 *
 * All three exported from one file so each router pattern maps to one export
 * while only this file owns the screens. Each wraps the ported `Page`
 * (account-plane cookie-session gating via AuthGuard) + dashboard `AppShell`
 * chrome. Profile/Sessions render only the current session record; there is no
 * subject-scoped session-enumeration API, so the only network calls are the
 * session helper's GET /v1/account/session/me (via Page → AuthGuard) and the
 * sign-out DELETE /v1/account/session/me (via clearSession).
 */

/** /account — hub nav links to the per-area account screens. */
export function AccountHubView() {
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
            <a href="/account/security">セキュリティ (passkey / 連携)</a>
            <a href="/account/tokens">Personal access tokens</a>
            <a href="/account/settings">Settings</a>
            <a href="/account/billing">Billing</a>
            <a href="/account/sessions">Sessions</a>
          </div>
        </AppShell>
      )}
    </Page>
  );
}

/** /account/settings — account + current Space settings overview. */
export function AccountSettingsView() {
  return (
    <Page title="Settings">
      {(session) => <SettingsInner session={session} />}
    </Page>
  );
}

function SettingsInner(props: { readonly session: SessionRecord }) {
  const [spaces, { mutate: mutateSpaces }] = createResource(listSpaces);
  const selectedSpace = createMemo(
    () =>
      (spaces() ?? []).find((space) => space.id === currentSpaceId()) ??
      (spaces() ?? [])[0],
  );
  const [displayNameDraft, setDisplayNameDraft] = createSignal("");
  const [policyDraft, setPolicyDraft] = createSignal("{}");
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);

  createEffect(() => {
    const space = selectedSpace();
    if (!space) return;
    setDisplayNameDraft(space.displayName);
    setPolicyDraft(JSON.stringify(space.policy ?? {}, null, 2));
    setSaveError(null);
    setSaveMessage(null);
  });

  const saveSpace = async (event: Event) => {
    event.preventDefault();
    const space = selectedSpace();
    if (!space) return;
    const displayName = displayNameDraft().trim();
    if (!displayName) {
      setSaveError("Space display name を入力してください。");
      return;
    }
    let policy: PolicyConfig;
    try {
      const parsed = JSON.parse(policyDraft());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setSaveError("Policy JSON は object にしてください。");
        return;
      }
      policy = parsed as PolicyConfig;
    } catch {
      setSaveError("Policy JSON が valid JSON ではありません。");
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const updated = await updateSpace(space.id, { displayName, policy });
      mutateSpaces((current) =>
        (current ?? []).map((item) => item.id === updated.id ? updated : item)
      );
      setCurrentSpaceId(updated.id);
      setSaveMessage("Space settings を保存しました。");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>Settings</h1>
        <p class="page-sub">
          Account identity と現在の Space 設定を管理します。
        </p>
      </div>

      <section class="detail-section">
        <h2>
          <Settings size={18} /> Account
        </h2>
        <dl class="kv-list">
          <dt>Subject</dt>
          <dd>
            <code>{props.session.subject}</code>
          </dd>
          <dt>Display name</dt>
          <dd>{props.session.displayName ?? "—"}</dd>
          <dt>Email</dt>
          <dd>{props.session.email ?? "—"}</dd>
          <dt>Primary account</dt>
          <dd>
            <Show
              when={props.session.primaryAccountId}
              fallback={<span class="muted">—</span>}
            >
              {(id) => <code>{id()}</code>}
            </Show>
          </dd>
        </dl>
        <div class="form-actions">
          <a class="btn btn-secondary btn-sm" href="/account/profile">
            プロフィール
          </a>
          <a class="btn btn-secondary btn-sm" href="/account/security">
            セキュリティ
          </a>
          <a class="btn btn-secondary btn-sm" href="/account/tokens">
            Tokens
          </a>
          <a class="btn btn-secondary btn-sm" href="/account/sessions">
            Sessions
          </a>
        </div>
      </section>

      <section class="detail-section">
        <h2>Current Space</h2>
        <Show
          when={!spaces.loading && (spaces() ?? []).length > 0}
          fallback={
            <p class="muted">
              {spaces.loading
                ? "Space を読み込み中..."
                : "Space はまだありません。"}
            </p>
          }
        >
          <label class="form-field settings-space-picker">
            Space
            <select
              value={selectedSpace()?.id ?? ""}
              onChange={(e) => setCurrentSpaceId(e.currentTarget.value)}
            >
              <For each={spaces() ?? []}>
                {(space) => (
                  <option value={space.id}>
                    @{space.handle} — {space.displayName}
                  </option>
                )}
              </For>
            </select>
          </label>
          <Show when={selectedSpace()}>
            {(space) => (
              <SpaceDetails
                space={space()}
                displayNameDraft={displayNameDraft()}
                policyDraft={policyDraft()}
                saving={saving()}
                saveError={saveError()}
                saveMessage={saveMessage()}
                onDisplayNameInput={setDisplayNameDraft}
                onPolicyInput={setPolicyDraft}
                onSubmit={saveSpace}
              />
            )}
          </Show>
        </Show>
      </section>
    </AppShell>
  );
}

function SpaceDetails(props: {
  readonly space: Space;
  readonly displayNameDraft: string;
  readonly policyDraft: string;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly saveMessage: string | null;
  readonly onDisplayNameInput: (value: string) => void;
  readonly onPolicyInput: (value: string) => void;
  readonly onSubmit: (event: Event) => void;
}) {
  return (
    <div class="settings-space-detail">
      <dl class="kv-list">
        <dt>Handle</dt>
        <dd>
          <code>@{props.space.handle}</code>
        </dd>
        <dt>Type</dt>
        <dd>
          <code>{props.space.type}</code>
        </dd>
        <dt>Owner</dt>
        <dd>
          <code>{props.space.ownerUserId}</code>
        </dd>
        <dt>Billing account</dt>
        <dd>
          <Show
            when={props.space.billingAccountId}
            fallback={<span class="muted">not linked</span>}
          >
            {(id) => <code>{id()}</code>}
          </Show>
        </dd>
        <dt>Updated</dt>
        <dd>{new Date(props.space.updatedAt).toLocaleString("ja-JP")}</dd>
      </dl>

      <form class="settings-space-form" onSubmit={props.onSubmit}>
        <label class="form-field">
          Display name
          <input
            value={props.displayNameDraft}
            onInput={(e) => props.onDisplayNameInput(e.currentTarget.value)}
          />
        </label>
        <label class="form-field">
          Space policy JSON
          <textarea
            class="settings-policy-editor"
            spellcheck={false}
            value={props.policyDraft}
            onInput={(e) => props.onPolicyInput(e.currentTarget.value)}
          />
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" disabled={props.saving}>
            <Save size={16} /> {props.saving ? "保存中..." : "保存"}
          </button>
        </div>
        <Show when={props.saveError}>
          {(message) => (
            <p class="sign-in-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={props.saveMessage}>
          {(message) => <p class="success-note">{message()}</p>}
        </Show>
      </form>
    </div>
  );
}

/** /account/billing — Space billing mode overview + optional hosted checkout. */
export function AccountBillingView() {
  return (
    <Page title="Billing">
      {(session) => <BillingInner session={session} />}
    </Page>
  );
}

function BillingInner(props: { readonly session: SessionRecord }) {
  const [spaces] = createResource(listSpaces);
  const [priceId, setPriceId] = createSignal("");
  const [mode, setMode] = createSignal<"subscription" | "payment">(
    "subscription",
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = createSignal<string | null>(null);
  const selectedSpace = createMemo(
    () =>
      (spaces() ?? []).find((space) => space.id === currentSpaceId()) ??
      (spaces() ?? [])[0],
  );

  const startCheckout = async (event: Event) => {
    event.preventDefault();
    const price = priceId().trim();
    if (!price) {
      setError("Stripe price ID を入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    setCheckoutUrl(null);
    try {
      const result = await rpc.billing.checkout({
        subject: props.session.subject,
        priceId: price,
        mode: mode(),
        customerEmail: props.session.email,
        metadata: {
          source: "takosumi_dashboard",
          ...(selectedSpace()
            ? {
                space_id: selectedSpace()!.id,
                space_handle: selectedSpace()!.handle,
              }
            : {}),
        },
      });
      if (result.url) {
        setCheckoutUrl(result.url);
        location.assign(result.url);
      } else {
        setError("Checkout URL が返りませんでした。");
      }
    } catch (err) {
      const api = err as ApiError;
      setError(api.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>Billing</h1>
        <p class="page-sub">
          Space billing mode は disabled / showback / enforce のいずれかです。
        </p>
      </div>

      <section class="detail-section">
        <h2>
          <CreditCard size={18} /> Billing context
        </h2>
        <dl class="kv-list">
          <dt>Account subject</dt>
          <dd>
            <code>{props.session.subject}</code>
          </dd>
          <dt>Email</dt>
          <dd>{props.session.email ?? "—"}</dd>
          <dt>Current Space</dt>
          <dd>
            <Show
              when={selectedSpace()}
              fallback={<span class="muted">Space 未選択</span>}
            >
              {(space) => (
                <>
                  <code>@{space().handle}</code>{" "}
                  <span class="muted">({space().id})</span>
                </>
              )}
            </Show>
          </dd>
          <dt>Billing mode</dt>
          <dd>disabled / showback / enforce</dd>
          <dt>Billing account</dt>
          <dd>
            <Show
              when={selectedSpace()?.billingAccountId}
              fallback={<span class="muted">not linked</span>}
            >
              {(id) => <code>{id()}</code>}
            </Show>
          </dd>
        </dl>
      </section>

      <section class="detail-section">
        <h2>Hosted checkout</h2>
        <form class="billing-checkout-form" onSubmit={startCheckout}>
          <label class="form-field">
            Price ID
            <input
              type="text"
              value={priceId()}
              onInput={(e) => setPriceId(e.currentTarget.value)}
              placeholder="price_..."
              autocomplete="off"
              spellcheck={false}
            />
          </label>
          <label class="form-field">
            Mode
            <select
              value={mode()}
              onChange={(e) =>
                setMode(
                  e.currentTarget.value === "payment"
                    ? "payment"
                    : "subscription",
                )
              }
            >
              <option value="subscription">subscription</option>
              <option value="payment">payment</option>
            </select>
          </label>
          <button class="btn btn-primary" type="submit" disabled={busy()}>
            {busy() ? "Checkout 作成中..." : "Checkout を開始"}
          </button>
        </form>
        <Show when={error()}>
          {(m) => (
            <p class="sign-in-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <Show when={checkoutUrl()}>
          {(url) => (
            <p class="muted">
              Redirecting to{" "}
              <a href={url()} rel="noreferrer">
                Stripe Checkout <ExternalLink size={14} />
              </a>
            </p>
          )}
        </Show>
      </section>
    </AppShell>
  );
}

/** /account/profile — current sign-in detail (read-only). */
export function AccountProfileView() {
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

/** /account/sessions — current browser session + sign-out. */
export function AccountSessionsView() {
  return (
    <Page title="Sessions">
      {(session) => <SessionsInner session={session} />}
    </Page>
  );
}

function SessionsInner(props: { session: SessionRecord }) {
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
