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
  changeSpaceSubscription,
  getSpaceBilling,
  listSpaceCreditReservations,
  listSpaceUsage,
  listSpaces,
  topUpSpaceCredits,
  updateSpace,
  type BillingMode,
  type BillingProvider,
  type BillingSettings,
  type CreditReservation,
  type PolicyConfig,
  type Space,
  type UsageEvent,
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
  const [checkoutMode, setCheckoutMode] = createSignal<
    "subscription" | "payment"
  >(
    "subscription",
  );
  const [checkoutBusy, setCheckoutBusy] = createSignal(false);
  const [checkoutError, setCheckoutError] = createSignal<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = createSignal<string | null>(null);
  const [portalBusy, setPortalBusy] = createSignal(false);
  const [portalError, setPortalError] = createSignal<string | null>(null);
  const [portalUrl, setPortalUrl] = createSignal<string | null>(null);
  const [billingMode, setBillingMode] =
    createSignal<BillingMode>("disabled");
  const [billingProvider, setBillingProvider] =
    createSignal<BillingProvider>("none");
  const [billingBusy, setBillingBusy] = createSignal(false);
  const [billingError, setBillingError] = createSignal<string | null>(null);
  const [billingMessage, setBillingMessage] = createSignal<string | null>(null);
  const [topUpCredits, setTopUpCredits] = createSignal("100");
  const [topUpBusy, setTopUpBusy] = createSignal(false);
  const selectedSpace = createMemo(
    () =>
      (spaces() ?? []).find((space) => space.id === currentSpaceId()) ??
      (spaces() ?? [])[0],
  );
  const selectedSpaceId = createMemo(() => selectedSpace()?.id);
  const [billing, { refetch: refetchBilling }] = createResource(
    selectedSpaceId,
    getSpaceBilling,
  );
  const [usage, { refetch: refetchUsage }] = createResource(
    selectedSpaceId,
    listSpaceUsage,
  );
  const [reservations, { refetch: refetchReservations }] = createResource(
    selectedSpaceId,
    listSpaceCreditReservations,
  );

  createEffect(() => {
    const settings = billing()?.settings ?? selectedSpace()?.billingSettings;
    if (!settings) return;
    setBillingMode(settings.mode);
    setBillingProvider(settings.provider);
  });

  const currentSettings = createMemo(
    () => billing()?.settings ?? selectedSpace()?.billingSettings,
  );
  const currentBalance = createMemo(() => billing()?.balance);

  const saveBillingSettings = async (event: Event) => {
    event.preventDefault();
    const space = selectedSpace();
    if (!space) return;
    const settings = buildBillingSettings(billingMode(), billingProvider());
    if (!settings) {
      setBillingError("enforce は stripe または manual provider が必要です。");
      return;
    }
    setBillingBusy(true);
    setBillingError(null);
    setBillingMessage(null);
    try {
      await changeSpaceSubscription(space.id, settings);
      await refetchBilling();
      setBillingMessage("Billing settings を保存しました。");
    } catch (err) {
      setBillingError(errorMessage(err));
    } finally {
      setBillingBusy(false);
    }
  };

  const submitTopUp = async (event: Event) => {
    event.preventDefault();
    const space = selectedSpace();
    if (!space) return;
    const credits = Number(topUpCredits());
    if (!Number.isSafeInteger(credits) || credits <= 0) {
      setBillingError("credits は正の整数で入力してください。");
      return;
    }
    setTopUpBusy(true);
    setBillingError(null);
    setBillingMessage(null);
    try {
      await topUpSpaceCredits(space.id, credits);
      await refetchBilling();
      await refetchUsage();
      await refetchReservations();
      setBillingMessage(`${credits} credits を追加しました。`);
    } catch (err) {
      setBillingError(errorMessage(err));
    } finally {
      setTopUpBusy(false);
    }
  };

  const startCheckout = async (event: Event) => {
    event.preventDefault();
    const price = priceId().trim();
    if (!price) {
      setCheckoutError("Stripe price ID を入力してください。");
      return;
    }
    setCheckoutBusy(true);
    setCheckoutError(null);
    setCheckoutUrl(null);
    try {
      const result = await rpc.billing.checkout({
        subject: props.session.subject,
        priceId: price,
        mode: checkoutMode(),
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
        setCheckoutError("Checkout URL が返りませんでした。");
      }
    } catch (err) {
      const api = err as ApiError;
      setCheckoutError(api.message ?? String(err));
    } finally {
      setCheckoutBusy(false);
    }
  };

  const openBillingPortal = async () => {
    setPortalBusy(true);
    setPortalError(null);
    setPortalUrl(null);
    try {
      const result = await rpc.billing.portal({
        subject: props.session.subject,
      });
      if (result.url) {
        setPortalUrl(result.url);
        location.assign(result.url);
      } else {
        setPortalError("Customer Portal URL が返りませんでした。");
      }
    } catch (err) {
      const api = err as ApiError;
      setPortalError(api.message ?? String(err));
    } finally {
      setPortalBusy(false);
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
          <dd>
            <code>{currentSettings()?.mode ?? "disabled"}</code>
          </dd>
          <dt>Billing provider</dt>
          <dd>
            <code>{currentSettings()?.provider ?? "none"}</code>
          </dd>
          <dt>Billing account</dt>
          <dd>
            <Show
              when={selectedSpace()?.billingAccountId}
              fallback={<span class="muted">not linked</span>}
            >
              {(id) => <code>{id()}</code>}
            </Show>
          </dd>
          <dt>Available credits</dt>
          <dd>{currentBalance()?.availableCredits ?? 0}</dd>
          <dt>Reserved credits</dt>
          <dd>{currentBalance()?.reservedCredits ?? 0}</dd>
        </dl>
      </section>

      <section class="detail-section">
        <h2>Space billing settings</h2>
        <form class="billing-settings-form" onSubmit={saveBillingSettings}>
          <label class="form-field">
            Mode
            <select
              value={billingMode()}
              onChange={(e) => {
                const next = e.currentTarget.value as BillingMode;
                setBillingMode(next);
                if (next === "disabled") setBillingProvider("none");
                if (next === "enforce" && billingProvider() === "none") {
                  setBillingProvider("manual");
                }
              }}
            >
              <option value="disabled">disabled</option>
              <option value="showback">showback</option>
              <option value="enforce">enforce</option>
            </select>
          </label>
          <label class="form-field">
            Provider
            <select
              value={billingProvider()}
              disabled={billingMode() === "disabled"}
              onChange={(e) =>
                setBillingProvider(e.currentTarget.value as BillingProvider)
              }
            >
              <option value="none">none</option>
              <option value="manual">manual</option>
              <option value="stripe">stripe</option>
            </select>
          </label>
          <button
            class="btn btn-primary"
            type="submit"
            disabled={billingBusy()}
          >
            <Save size={16} />
            {billingBusy() ? "保存中..." : "保存"}
          </button>
        </form>
        <form class="billing-settings-form" onSubmit={submitTopUp}>
          <label class="form-field">
            Top-up credits
            <input
              type="number"
              min="1"
              step="1"
              value={topUpCredits()}
              onInput={(e) => setTopUpCredits(e.currentTarget.value)}
            />
          </label>
          <button class="btn" type="submit" disabled={topUpBusy()}>
            {topUpBusy() ? "追加中..." : "Credits を追加"}
          </button>
        </form>
        <Show when={billingError()}>
          {(m) => (
            <p class="sign-in-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <Show when={billingMessage()}>
          {(m) => <p class="success-note">{m()}</p>}
        </Show>
      </section>

      <section class="detail-section">
        <h2>Credit reservations</h2>
        <Show
          when={(reservations() ?? []).length > 0}
          fallback={<p class="muted">credit reservation はまだありません。</p>}
        >
          <table class="data-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Credits</th>
                <th>Mode</th>
                <th>Run</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              <For each={reservations() ?? []}>
                {(reservation) => (
                  <BillingReservationRow reservation={reservation} />
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </section>

      <section class="detail-section">
        <h2>Usage</h2>
        <Show
          when={(usage() ?? []).length > 0}
          fallback={<p class="muted">usage event はまだありません。</p>}
        >
          <table class="data-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Quantity</th>
                <th>Credits</th>
                <th>Run</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              <For each={usage() ?? []}>
                {(event) => <BillingUsageRow event={event} />}
              </For>
            </tbody>
          </table>
        </Show>
      </section>

      <section class="detail-section">
        <h2>Hosted billing</h2>
        <div class="billing-settings-form">
          <button
            class="btn"
            type="button"
            disabled={portalBusy()}
            onClick={openBillingPortal}
          >
            <ExternalLink size={16} />
            {portalBusy() ? "Portal 作成中..." : "Customer Portal を開く"}
          </button>
        </div>
        <Show when={portalError()}>
          {(m) => (
            <p class="sign-in-error" role="alert">
              {m()}
            </p>
          )}
        </Show>
        <Show when={portalUrl()}>
          {(url) => (
            <p class="muted">
              Redirecting to{" "}
              <a href={url()} rel="noreferrer">
                Stripe Customer Portal <ExternalLink size={14} />
              </a>
            </p>
          )}
        </Show>
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
              value={checkoutMode()}
              onChange={(e) =>
                setCheckoutMode(
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
          <button
            class="btn btn-primary"
            type="submit"
            disabled={checkoutBusy()}
          >
            {checkoutBusy() ? "Checkout 作成中..." : "Checkout を開始"}
          </button>
        </form>
        <Show when={checkoutError()}>
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

function buildBillingSettings(
  mode: BillingMode,
  provider: BillingProvider,
): BillingSettings | null {
  if (mode === "disabled") {
    return { mode: "disabled", provider: "none", reservationRequired: false };
  }
  if (mode === "showback") {
    return { mode: "showback", provider, reservationRequired: false };
  }
  if (provider === "none") return null;
  return { mode: "enforce", provider, reservationRequired: true };
}

function BillingUsageRow(props: { readonly event: UsageEvent }) {
  return (
    <tr>
      <td>
        <code>{props.event.kind}</code>
      </td>
      <td>{props.event.quantity}</td>
      <td>{props.event.credits}</td>
      <td>
        <Show
          when={props.event.runId}
          fallback={<span class="muted">—</span>}
        >
          {(runId) => <code>{runId()}</code>}
        </Show>
      </td>
      <td>{formatDateTime(props.event.createdAt)}</td>
    </tr>
  );
}

function BillingReservationRow(props: {
  readonly reservation: CreditReservation;
}) {
  return (
    <tr>
      <td>
        <code>{props.reservation.status}</code>
      </td>
      <td>{props.reservation.estimatedCredits}</td>
      <td>{props.reservation.mode}</td>
      <td>
        <code>{props.reservation.runId}</code>
      </td>
      <td>{formatDateTime(props.reservation.expiresAt)}</td>
    </tr>
  );
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toLocaleString("ja-JP");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
