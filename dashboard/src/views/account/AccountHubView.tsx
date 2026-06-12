import "../../styles/wave-c.css";
import {
  CreditCard,
  ExternalLink,
  LogOut,
  Monitor,
  Save,
  Settings,
  User,
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
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  type Column,
  DataTable,
  FormField,
  Input,
  KVList,
  PageHeader,
  Select,
  Textarea,
  Toast,
} from "../../components/ui/index.ts";
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

/**
 * Plain-Japanese label + recognition sub-label for each management surface, kept
 * identical to the desktop Sidebar's ADVANCED set so the same words describe the
 * same screen everywhere (no second, divergent copy). On phones the sidebar is
 * hidden, so this hub is the only chrome that lists these screens — without it
 * they would be URL-typing-only on mobile.
 */
// Only routes that actually exist in the router are listed here. `/account/
// security` and `/account/tokens` have no registered route or view yet, so they
// are intentionally omitted — linking to them would silently bounce the visitor
// to /home via the catch-all, which reads as a broken button.
const ACCOUNT_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/account/profile", label: "プロフィール" },
  { href: "/account/settings", label: "設定" },
  { href: "/account/billing", label: "お支払い" },
  { href: "/account/sessions", label: "サインイン中の端末" },
];

const MANAGE_LINKS: ReadonlyArray<{
  href: string;
  label: string;
  sub?: string;
}> = [
  { href: "/apps", label: "アプリ一覧" },
  { href: "/installations", label: "導入の管理", sub: "Installations" },
  { href: "/sources", label: "ソース", sub: "Sources" },
  { href: "/providers", label: "プロバイダ", sub: "Providers" },
  { href: "/graph", label: "依存グラフ", sub: "Dependency graph" },
  { href: "/output-shares", label: "出力の共有", sub: "Output shares" },
  { href: "/backups", label: "バックアップ", sub: "Backups" },
  { href: "/members", label: "メンバー", sub: "Members" },
];

/** /account — hub nav links to the per-area account + management screens. */
export function AccountHubView() {
  return (
    <Page title="Account">
      {() => (
        <AppShell>
          <PageHeader
            eyebrow="Account"
            title="アカウント"
            subtitle="プロフィール、設定、お支払い、アプリの管理。"
          />

          <div class="wc-stack">
            <Card>
              <CardHeader title="アカウント設定" />
              <div class="wc-nav-grid">
                {ACCOUNT_LINKS.map((link) => (
                  <a class="wc-nav-card" href={link.href}>
                    {link.label}
                  </a>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="アプリの管理"
                subtitle="導入したアプリ、接続元、連携、バックアップなどの詳細管理。"
              />
              <div class="wc-nav-grid">
                {MANAGE_LINKS.map((link) => (
                  <a class="wc-nav-card" href={link.href}>
                    <span>{link.label}</span>
                    {link.sub
                      ? <span class="wc-nav-card-spec">{link.sub}</span>
                      : null}
                  </a>
                ))}
              </div>
            </Card>
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
      <PageHeader
        eyebrow="Settings"
        title="設定"
        subtitle="Account identity と現在の Space 設定を管理します。"
      />

      <div class="wc-stack">
        <Card>
          <CardHeader
            title={
              <span style="display:inline-flex;align-items:center;gap:8px">
                <Settings size={18} /> Account
              </span>
            }
          />
          <KVList
            items={[
              {
                label: "Subject",
                value: <code class="wc-code">{props.session.subject}</code>,
              },
              { label: "Display name", value: props.session.displayName ?? "—" },
              { label: "Email", value: props.session.email ?? "—" },
              {
                label: "Primary account",
                value: (
                  <Show
                    when={props.session.primaryAccountId}
                    fallback={<span class="muted">—</span>}
                  >
                    {(id) => <code class="wc-code">{id()}</code>}
                  </Show>
                ),
              },
            ]}
          />
          <CardSection>
            <div class="wc-form-actions">
              <Button variant="secondary" size="sm" href="/account/profile">
                プロフィール
              </Button>
              <Button variant="secondary" size="sm" href="/account/sessions">
                サインイン中の端末
              </Button>
            </div>
          </CardSection>
        </Card>

        <Card>
          <CardHeader title="Current Space" />
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
            <FormField label="Space" class="settings-space-picker">
              <Select
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
              </Select>
            </FormField>
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
        </Card>
      </div>
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
    <CardSection class="settings-space-detail">
      <KVList
        items={[
          {
            label: "Handle",
            value: <code class="wc-code">@{props.space.handle}</code>,
          },
          {
            label: "Type",
            value: <code class="wc-code">{props.space.type}</code>,
          },
          {
            label: "Owner",
            value: <code class="wc-code">{props.space.ownerUserId}</code>,
          },
          {
            label: "Billing account",
            value: (
              <Show
                when={props.space.billingAccountId}
                fallback={<span class="muted">not linked</span>}
              >
                {(id) => <code class="wc-code">{id()}</code>}
              </Show>
            ),
          },
          {
            label: "Updated",
            value: new Date(props.space.updatedAt).toLocaleString("ja-JP"),
          },
        ]}
      />

      <form class="wc-form settings-space-form" onSubmit={props.onSubmit}>
        <FormField label="Display name">
          <Input
            value={props.displayNameDraft}
            onInput={(e) => props.onDisplayNameInput(e.currentTarget.value)}
          />
        </FormField>
        <FormField label="Space policy JSON">
          <Textarea
            class="wc-policy-editor"
            spellcheck={false}
            value={props.policyDraft}
            onInput={(e) => props.onPolicyInput(e.currentTarget.value)}
          />
        </FormField>
        <div class="wc-form-actions">
          <Button
            variant="primary"
            type="submit"
            busy={props.saving}
            icon={<Save size={16} />}
          >
            {props.saving ? "保存中..." : "保存"}
          </Button>
        </div>
        <Show when={props.saveError}>
          {(message) => <Toast tone="error">{message()}</Toast>}
        </Show>
        <Show when={props.saveMessage}>
          {(message) => <Toast tone="success">{message()}</Toast>}
        </Show>
      </form>
    </CardSection>
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

  const reservationColumns: readonly Column<CreditReservation>[] = [
    { header: "Status", cell: (r) => <code class="wc-code">{r.status}</code> },
    { header: "Credits", cell: (r) => r.estimatedCredits },
    { header: "Mode", cell: (r) => r.mode },
    { header: "Run", cell: (r) => <code class="wc-code">{r.runId}</code> },
    { header: "Expires", cell: (r) => formatDateTime(r.expiresAt) },
  ];

  const usageColumns: readonly Column<UsageEvent>[] = [
    { header: "Kind", cell: (e) => <code class="wc-code">{e.kind}</code> },
    { header: "Quantity", cell: (e) => e.quantity },
    { header: "Credits", cell: (e) => e.credits },
    {
      header: "Run",
      cell: (e) => (
        <Show when={e.runId} fallback={<span class="muted">—</span>}>
          {(runId) => <code class="wc-code">{runId()}</code>}
        </Show>
      ),
    },
    { header: "Created", cell: (e) => formatDateTime(e.createdAt) },
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="Billing"
        title="お支払い"
        subtitle="Space billing mode は disabled / showback / enforce のいずれかです。"
      />

      <div class="wc-stack">
        <Card>
          <CardHeader
            title={
              <span style="display:inline-flex;align-items:center;gap:8px">
                <CreditCard size={18} /> Billing context
              </span>
            }
          />
          <KVList
            items={[
              {
                label: "Account subject",
                value: <code class="wc-code">{props.session.subject}</code>,
              },
              { label: "Email", value: props.session.email ?? "—" },
              {
                label: "Current Space",
                value: (
                  <Show
                    when={selectedSpace()}
                    fallback={<span class="muted">Space 未選択</span>}
                  >
                    {(space) => (
                      <>
                        <code class="wc-code">@{space().handle}</code>{" "}
                        <span class="muted">({space().id})</span>
                      </>
                    )}
                  </Show>
                ),
              },
              {
                label: "Billing mode",
                value: (
                  <code class="wc-code">
                    {currentSettings()?.mode ?? "disabled"}
                  </code>
                ),
              },
              {
                label: "Billing provider",
                value: (
                  <code class="wc-code">
                    {currentSettings()?.provider ?? "none"}
                  </code>
                ),
              },
              {
                label: "Billing account",
                value: (
                  <Show
                    when={selectedSpace()?.billingAccountId}
                    fallback={<span class="muted">not linked</span>}
                  >
                    {(id) => <code class="wc-code">{id()}</code>}
                  </Show>
                ),
              },
              {
                label: "Available credits",
                value: currentBalance()?.availableCredits ?? 0,
              },
              {
                label: "Reserved credits",
                value: currentBalance()?.reservedCredits ?? 0,
              },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Space billing settings" />
          <div class="wc-card-stack">
            <form class="wc-form" onSubmit={saveBillingSettings}>
              <FormField label="Mode">
                <Select
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
                </Select>
              </FormField>
              <FormField label="Provider">
                <Select
                  value={billingProvider()}
                  disabled={billingMode() === "disabled"}
                  onChange={(e) =>
                    setBillingProvider(e.currentTarget.value as BillingProvider)
                  }
                >
                  <option value="none">none</option>
                  <option value="manual">manual</option>
                  <option value="stripe">stripe</option>
                </Select>
              </FormField>
              <div class="wc-form-actions">
                <Button
                  variant="primary"
                  type="submit"
                  busy={billingBusy()}
                  icon={<Save size={16} />}
                >
                  {billingBusy() ? "保存中..." : "保存"}
                </Button>
              </div>
            </form>
            <form class="wc-form" onSubmit={submitTopUp}>
              <FormField label="Top-up credits">
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={topUpCredits()}
                  onInput={(e) => setTopUpCredits(e.currentTarget.value)}
                />
              </FormField>
              <div class="wc-form-actions">
                <Button variant="secondary" type="submit" busy={topUpBusy()}>
                  {topUpBusy() ? "追加中..." : "Credits を追加"}
                </Button>
              </div>
            </form>
            <Show when={billingError()}>
              {(m) => <Toast tone="error">{m()}</Toast>}
            </Show>
            <Show when={billingMessage()}>
              {(m) => <Toast tone="success">{m()}</Toast>}
            </Show>
          </div>
        </Card>

        <Card>
          <CardHeader title="Credit reservations" />
          <Show
            when={(reservations() ?? []).length > 0}
            fallback={
              <p class="muted">credit reservation はまだありません。</p>
            }
          >
            <DataTable
              columns={reservationColumns}
              rows={reservations() ?? []}
              rowKey={(r) => r.runId}
            />
          </Show>
        </Card>

        <Card>
          <CardHeader title="Usage" />
          <Show
            when={(usage() ?? []).length > 0}
            fallback={<p class="muted">usage event はまだありません。</p>}
          >
            <DataTable
              columns={usageColumns}
              rows={usage() ?? []}
              rowKey={(_e, i) => i}
            />
          </Show>
        </Card>

        <Card>
          <CardHeader title="Hosted billing" />
          <div class="wc-card-stack">
            <div class="wc-form-actions">
              <Button
                variant="secondary"
                type="button"
                busy={portalBusy()}
                onClick={openBillingPortal}
                icon={<ExternalLink size={16} />}
              >
                {portalBusy() ? "Portal 作成中..." : "Customer Portal を開く"}
              </Button>
            </div>
            <Show when={portalError()}>
              {(m) => <Toast tone="error">{m()}</Toast>}
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

            <CardSection>
              <CardHeader title="Hosted checkout" />
              <form class="wc-form" onSubmit={startCheckout}>
                <FormField label="Price ID">
                  <Input
                    type="text"
                    value={priceId()}
                    onInput={(e) => setPriceId(e.currentTarget.value)}
                    placeholder="price_..."
                    autocomplete="off"
                    spellcheck={false}
                  />
                </FormField>
                <FormField label="Mode">
                  <Select
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
                  </Select>
                </FormField>
                <div class="wc-form-actions">
                  <Button
                    variant="primary"
                    type="submit"
                    busy={checkoutBusy()}
                  >
                    {checkoutBusy() ? "Checkout 作成中..." : "Checkout を開始"}
                  </Button>
                </div>
              </form>
              <Show when={checkoutError()}>
                {(m) => <Toast tone="error">{m()}</Toast>}
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
            </CardSection>
          </div>
        </Card>
      </div>
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
          <PageHeader
            eyebrow="Profile"
            title="プロフィール"
            subtitle="現在のサインイン情報。"
          />
          <Card>
            <CardHeader
              title={
                <span style="display:inline-flex;align-items:center;gap:8px">
                  <User size={18} /> サインイン情報
                </span>
              }
            />
            <KVList
              items={[
                {
                  label: "Subject",
                  value: <code class="wc-code">{session.subject}</code>,
                },
                { label: "Display name", value: session.displayName ?? "—" },
                { label: "Email", value: session.email ?? "—" },
                { label: "Provider", value: session.provider ?? "—" },
                {
                  label: "Session expires",
                  value: new Date(session.expiresAt).toLocaleString("ja-JP"),
                },
              ]}
            />
          </Card>
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
      <PageHeader
        eyebrow="Sessions"
        title="サインイン中の端末"
        subtitle="アクティブなブラウザセッションの管理。"
      />

      <div class="wc-stack">
        <Card>
          <CardHeader
            title={
              <span style="display:inline-flex;align-items:center;gap:8px">
                <Monitor size={18} /> 現在のセッション
              </span>
            }
          />
          <KVList
            items={[
              {
                label: "Session ID",
                value: <code class="wc-code">{props.session.sessionId}</code>,
              },
              {
                label: "Subject",
                value: <code class="wc-code">{props.session.subject}</code>,
              },
              { label: "Provider", value: props.session.provider ?? "—" },
              {
                label: "Expires",
                value: new Date(props.session.expiresAt).toLocaleString(
                  "ja-JP",
                ),
              },
              {
                label: "User-Agent",
                value: <span class="muted">{navigator.userAgent}</span>,
              },
            ]}
          />
          <CardSection>
            <Show
              when={confirming()}
              fallback={
                <Button
                  variant="danger"
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={busy()}
                  icon={<LogOut size={16} />}
                >
                  このブラウザからサインアウト
                </Button>
              }
            >
              <div class="wc-form-actions">
                <span class="muted">
                  このブラウザからサインアウトしますか？
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  type="button"
                  onClick={signOutThisBrowser}
                  disabled={busy()}
                  icon={<LogOut size={14} />}
                >
                  サインアウト
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy()}
                >
                  取消
                </Button>
              </div>
            </Show>
          </CardSection>
        </Card>

        <Card>
          <CardHeader title="他デバイスのセッション" />
          <p class="muted">
            他デバイスのセッション一覧とリモートサインアウト (coming soon):
            現在この account-plane は subject ごとのセッション列挙 API
            を持たないため、ここで管理できるのは上記の現在のブラウザのみです。
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
