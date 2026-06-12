import "../../styles/wave-c.css";
import {
  createEffect,
  createMemo,
  createResource,
  For,
  type JSX,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { createSignal } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import AppShell from "./components/shell/AppShell.tsx";
import Page from "./components/auth/Page.tsx";
import InkdropMark from "./components/brand/InkdropMark.tsx";
import InkBackdrop from "../../components/ui/InkBackdrop.tsx";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
  Toast,
} from "../../components/ui/index.ts";
// wave-d: legacy install-flow views (InstallWizard / InstallByUrlView /
// TakosStartView) use these shared components. Imported under a dedicated,
// aliased block so it does not collide with the account/home (wave-c) imports
// above in this shared file.
import "../../styles/wave-d.css";
import {
  Button as DButton,
  Card as DCard,
  CardHeader as DCardHeader,
  CardSection as DCardSection,
  Checkbox as DCheckbox,
  FormField as DFormField,
  Input as DInput,
  KVList as DKVList,
  PageHeader as DPageHeader,
  Select as DSelect,
} from "../../components/ui/index.ts";
import { Icons } from "../../lib/Icons.tsx";
import { ApiError, type InstallationPlanResponse, rpc } from "./lib/api.ts";
import {
  type ActivityEvent,
  type ControlApiError,
  listActivity,
  listSpaces,
  type Space,
} from "../../lib/control-api.ts";
import {
  readSession,
  refreshSession,
  type SessionRecord,
} from "./lib/session.ts";

/**
 * AccountMiscViews — the grab-bag of small/static account-plane screens ported
 * from the takosumi `dashboard-ui` package into the takos web SPA. They all talk
 * to the same-origin `/v1/*` account plane that is mounted in-process in
 * `takos/src/worker/web.ts` (single-operator, single-worker, bare-origin
 * issuer). Bundled into one file so a single agent owns these last, highest-
 * uncertainty screens.
 *
 * Named exports:
 *  - InstallWizard / InstallByUrlView                  — install-by-URL
 *  - SignInView / SignInCallbackView / SignInPanel       — upstream OAuth sign-in
 *  - TakosStartView                                       — Takos product launch
 *  - HomeView / NotificationsView / AccountIndexView      — landing / placeholders
 *
 * Titles are set via `document.title` (the takos SPA does not depend on
 * `@solidjs/meta`); icons use the local `Icons` set rather than `lucide-solid`.
 */

/** Set the document title to the takosumi-account-plane pattern. */
function useDocumentTitle(title: string): void {
  onMount(() => {
    if (typeof document !== "undefined") {
      document.title = `${title} — Takosumi`;
    }
  });
}

// ===========================================================================
// Install wizard (install-by-URL)
// ===========================================================================

// NOTE (simplify): `dedicated` / `self-hosted` reflect the dead multi-mode
// world. In the single-operator merged deployment everything is one cell, so
// the mode picker is functionally a no-op kept for wire-compat. A follow-up
// should collapse this to `shared-cell` only and drop the <select>.
type Mode = "shared-cell" | "dedicated" | "self-hosted";

/**
 * The install-by-URL wizard. Shared by the canonical `/install` route and the
 * in-dashboard `/apps/install` route. Pre-fills from URL query
 * (?git=...&ref=...&mode=...&space=...&account=...&autoplan=1) so product
 * landing pages can deep-link straight into install with the source already
 * filled in, and `autoplan=1` creates a plan run on mount.
 *
 * API: POST /v1/app-installations/plan-runs, POST /v1/app-installations.
 */
export function InstallWizard() {
  const nav = useNavigate();
  const [params] = useSearchParams<{
    git?: string;
    ref?: string;
    mode?: string;
    space?: string;
    account?: string;
    autoplan?: string;
  }>();

  const [gitUrl, setGitUrl] = createSignal(params.git ?? "");
  const [ref, setRef] = createSignal(params.ref ?? "main");
  const initialMode: Mode =
    params.mode === "dedicated" || params.mode === "self-hosted"
      ? params.mode
      : "shared-cell";
  const [mode, setMode] = createSignal<Mode>(initialMode);
  // New-user one-click install: fall back to the session's primary account and
  // a freshly generated space so `autoplan` can fire and Plan/Install enable
  // even for a cold visitor who has no account/space yet. Fields stay editable
  // for users targeting an existing account/space (their last-used ids are
  // restored from localStorage).
  const [spaceId, setSpaceId] = createSignal(
    params.space ?? storedValue("tg_apps_space_id") ?? generatedId("space"),
  );
  const [accountId, setAccountId] = createSignal(
    params.account ??
      storedValue("tg_apps_account_id") ??
      readSession()?.primaryAccountId ??
      generatedId("acct"),
  );

  const [planPreview, setPlanPreview] =
    createSignal<InstallationPlanResponse | null>(null);
  const [planChecking, setPlanChecking] = createSignal(false);
  const [installing, setInstalling] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [autoPlanFired, setAutoPlanFired] = createSignal(false);

  const runPlanPreview = async (e?: Event) => {
    e?.preventDefault();
    setErr(null);
    setPlanPreview(null);
    setPlanChecking(true);
    try {
      const result = await rpc.installations.plan({
        gitUrl: gitUrl(),
        ref: ref(),
        spaceId: spaceId(),
      });
      setPlanPreview(result);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setPlanChecking(false);
    }
  };

  // ?autoplan=1 with a git URL creates a plan run once on mount.
  createEffect(() => {
    if (
      params.autoplan === "1" &&
      gitUrl() &&
      spaceId() &&
      !autoPlanFired() &&
      !planChecking() &&
      !planPreview()
    ) {
      setAutoPlanFired(true);
      void runPlanPreview();
    }
  });

  const runInstall = async () => {
    setErr(null);
    const p = planPreview();
    if (!p) {
      setErr("先に「変更を確認」を実行してください。");
      return;
    }
    const session = readSession();
    if (!session) {
      setErr("session が見つかりません。 再ログインしてください。");
      return;
    }
    const appId = pickString(p, [
      "repo.id",
      "source.repositoryUrl",
      "source.url",
    ]);
    const commit = pickString(p, ["expected.sourceCommit", "source.commit"]);
    const planDigest = pickString(p, ["expected.planDigest", "planDigest"]);
    if (!appId || !commit || !planDigest) {
      setErr(
        "変更の確認結果を公開に使用できませんでした。時間をおいて再度お試しください。",
      );
      return;
    }
    setInstalling(true);
    try {
      const created = await rpc.installations.create({
        accountId: accountId(),
        spaceId: spaceId(),
        appId,
        source: {
          gitUrl: gitUrl(),
          ref: ref(),
          commit,
          planDigest,
        },
        mode: mode(),
        createdBySubject: session.subject,
      });
      localStorage.setItem("tg_apps_account_id", accountId());
      localStorage.setItem("tg_apps_space_id", spaceId());
      nav(`/apps/${encodeURIComponent(created.installationId)}`);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <AppShell>
      <DPageHeader
        eyebrow="Install"
        title="アプリを追加"
        subtitle="Git リポジトリから takosumi 上にアプリを追加します。"
      />

      <div class="wave-d-stack">
        <DCard>
          <DCardHeader title="Source" />
          <DCardSection>
            <form class="wave-d-field-stack" onSubmit={runPlanPreview}>
              <DFormField label="Git URL" required>
                <DInput
                  type="url"
                  value={gitUrl()}
                  onInput={(e) => setGitUrl(e.currentTarget.value)}
                  placeholder="https://github.com/owner/repo.git"
                  required
                />
              </DFormField>
              <DFormField label="Ref" required>
                <DInput
                  type="text"
                  value={ref()}
                  onInput={(e) => setRef(e.currentTarget.value)}
                  placeholder="main"
                  required
                />
              </DFormField>
              <div class="wave-d-actions">
                <DButton
                  variant="secondary"
                  type="submit"
                  disabled={planChecking() || !gitUrl() || !spaceId()}
                  busy={planChecking()}
                  icon={<Icons.GitBranch class="w-4 h-4" />}
                >
                  {planChecking() ? "変更を確認中..." : "変更を確認"}
                </DButton>
              </div>
            </form>
          </DCardSection>
        </DCard>

        <Show when={planPreview()}>
          {(p) => (
            <DCard>
              <DCardHeader title="変更内容の確認" />
              <DCardSection>
                <DKVList
                  items={[
                    {
                      label: "App ID",
                      value:
                        pickString(p(), [
                          "repo.id",
                          "source.repositoryUrl",
                          "source.url",
                        ]) ?? "—",
                    },
                    {
                      label: "Commit",
                      value: (
                        <code class="wave-d-mono">
                          {pickString(p(), [
                            "source.commit",
                            "expected.sourceCommit",
                          ]) ?? "—"}
                        </code>
                      ),
                    },
                    {
                      label: "Plan digest",
                      value: (
                        <code class="wave-d-mono">
                          {pickString(p(), ["planDigest"]) ?? "—"}
                        </code>
                      ),
                    },
                    {
                      label: "Expected plan digest",
                      value: (
                        <code class="wave-d-mono">
                          {pickString(p(), ["expected.planDigest"]) ?? "—"}
                        </code>
                      ),
                    },
                  ]}
                />
              </DCardSection>
            </DCard>
          )}
        </Show>

        <DCard>
          <DCardHeader title="Target" />
          <DCardSection>
            <div class="wave-d-field-grid">
              <DFormField label="Account ID">
                <DInput
                  type="text"
                  value={accountId()}
                  onInput={(e) => setAccountId(e.currentTarget.value)}
                  placeholder="acct_xxxxx"
                />
              </DFormField>
              <DFormField label="Space ID">
                <DInput
                  type="text"
                  value={spaceId()}
                  onInput={(e) => setSpaceId(e.currentTarget.value)}
                  placeholder="space_xxxxx"
                />
              </DFormField>
              <DFormField label="Mode">
                <DSelect
                  value={mode()}
                  onChange={(e) => setMode(e.currentTarget.value as Mode)}
                >
                  <option value="shared-cell">shared-cell</option>
                  <option value="dedicated">dedicated</option>
                  <option value="self-hosted">self-hosted</option>
                </DSelect>
              </DFormField>
            </div>
          </DCardSection>
        </DCard>

        <Show when={err()}>{(m) => <p class="wave-d-error">{m()}</p>}</Show>

        <DCard>
          <DCardSection>
            <div class="wave-d-actions">
              <DButton
                variant="primary"
                type="button"
                onClick={runInstall}
                disabled={
                  installing() || !planPreview() || !accountId() || !spaceId()
                }
                busy={installing()}
                icon={<Icons.Server class="w-4 h-4" />}
              >
                {installing() ? "公開中..." : "公開"}
              </DButton>
              <DButton href="/apps" variant="secondary">
                キャンセル
              </DButton>
            </div>
            <p class="tg-card-subtitle" style="margin-top: 12px;">
              公開先の account と space を確認してから実行してください。
            </p>
          </DCardSection>
        </DCard>
      </div>
    </AppShell>
  );
}

/**
 * Canonical install-by-URL entry. The official, advertised way to install any
 * OpenTofu-module repo: open `/install?git=<repo>&ref=<ref>&mode=<mode>&autoplan=1`
 * and the wizard pre-fills + creates the plan run.
 */
export function InstallByUrlView() {
  return <Page title="アプリを追加">{() => <InstallWizard />}</Page>;
}

// ===========================================================================
// Sign-in (upstream OAuth) + OAuth callback
// ===========================================================================

// CAVEAT (reconcile): in the single-operator merged world the bare-origin
// issuer means the takos product already has its own login flow
// (`views/app/AuthViews.tsx` LoginPage + `hooks/useAuth.tsx`) that drives the
// in-worker OIDC consumer. This SignInPanel is the account-plane's OWN sign-in
// (cookie session via `./lib/session.ts`, distinct from takos `useAuth`). For
// the merged deployment the router agent should decide whether to:
//   (a) route `/sign-in` here (account-plane cookie session), or
//   (b) redirect `/sign-in` to the existing takos LoginPage and drop this panel.
// Ported functionally so option (a) works out of the box; flagged for
// simplification. The dashboard-ui dev-sign-in shortcut is intentionally NOT
// ported (it wrote a fake session and is not part of the shared plan).

type Provider = "passkey" | "google" | "github";

interface ProviderInfo {
  id: Provider;
  label: string;
  /** Sub-text shown when the provider is enabled (e.g. the protocol). */
  sub: string;
  /** Sub-text shown when the operator has not configured this provider. */
  disabledSub: string;
  icon: () => JSX.Element;
}

// Static presentation descriptors. Whether each method is actually enabled is
// resolved at runtime from `GET /v1/auth/providers` (operator config), so we
// never render an enabled button whose backend would answer 503.
const PROVIDERS: ProviderInfo[] = [
  {
    id: "passkey",
    label: "Passkey で続ける",
    sub: "WebAuthn",
    disabledSub: "準備中",
    icon: () => (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        <circle cx="12" cy="16" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "google",
    label: "Google で続ける",
    sub: "OAuth 2.0",
    disabledSub: "オペレーターが未設定です",
    icon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4c-.2 1.3-1 2.4-2 3.1v2.6h3.3c2-1.8 3-4.5 3-7.5z" />
        <path d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.6c-.9.6-2.1 1-3.4 1-2.6 0-4.9-1.8-5.7-4.2H3v2.6C4.7 19.7 8.1 22 12 22z" />
        <path d="M6.3 13.8c-.2-.6-.3-1.2-.3-1.8s.1-1.2.3-1.8V7.6H3C2.4 8.9 2 10.4 2 12s.4 3.1 1 4.4l3.3-2.6z" />
        <path d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9C16.9 2.9 14.7 2 12 2 8.1 2 4.7 4.3 3 7.6l3.3 2.6c.8-2.4 3.1-4.3 5.7-4.3z" />
      </svg>
    ),
  },
  {
    id: "github",
    label: "GitHub で続ける",
    sub: "OAuth 2.0",
    disabledSub: "オペレーターが未設定です",
    icon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.32-1.28-1.67-1.28-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.07.78 2.15v3.18c0 .31.21.68.8.56C20.21 21.38 23.5 17.07 23.5 12 23.5 5.65 18.35.5 12 .5z" />
      </svg>
    ),
  },
];

/**
 * Account-plane sign-in panel. Navigation-based upstream OAuth (Google/GitHub);
 * passkey is a placeholder. See the reconcile CAVEAT above before wiring routes.
 *
 * Which providers are clickable is resolved at runtime from
 * `GET /v1/auth/providers` (operator config). Until that resolves — and for any
 * provider the operator never configured — the button renders disabled with an
 * "operator not configured" hint, so a user never clicks a method whose backend
 * would answer 503 (audit S4).
 */
export function SignInPanel() {
  const [error, setError] = createSignal<string | null>(null);
  // Start all-disabled and flip on by config: failing closed means we never
  // briefly render an enabled button that the backend would 503.
  const [enabled, setEnabled] = createSignal<Record<string, boolean>>({});

  onMount(() => {
    void rpc.auth
      .listProviders()
      .then((res) => {
        const map: Record<string, boolean> = {};
        for (const provider of res.providers) {
          map[provider.id] = provider.enabled;
        }
        setEnabled(map);
      })
      .catch(() => {
        // Leave every method disabled if availability can't be read; the user
        // sees the "operator not configured" hint rather than a button that
        // would 503 on click.
      });
  });

  // Passkey is never clickable from this panel: the account-plane exposes the
  // WebAuthn ceremony, but the dashboard ships no authenticate/enroll client,
  // so even when the operator configures RP env vars (server reports it as
  // enabled) the button would only error. Probe-gate it off here so it renders
  // as a disabled "準備中" placeholder rather than a control that lies.
  const isEnabled = (p: Provider): boolean =>
    p !== "passkey" && enabled()[p] === true;

  const select = (p: Provider) => {
    setError(null);
    if (!isEnabled(p) || p === "passkey") return;
    rpc.auth.startUpstreamOAuth(p);
  };

  return (
    <div class="sign-in-panel">
      <h1 class="sign-in-title">サインイン</h1>
      <p class="sign-in-sub">Takosumi のアカウントで続けます。</p>
      <div class="sign-in-buttons">
        {PROVIDERS.map((p) => (
          <button
            type="button"
            class="sign-in-btn"
            data-provider={p.id}
            disabled={!isEnabled(p.id)}
            onClick={() => select(p.id)}
          >
            <span class="sign-in-icon">{p.icon()}</span>
            <span class="sign-in-text">
              <span class="sign-in-label">{p.label}</span>
              <span class="sign-in-sub-text">
                {isEnabled(p.id) ? p.sub : p.disabledSub}
              </span>
            </span>
            <svg
              class="sign-in-arrow"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        ))}
      </div>
      <Show when={error()}>
        {(msg) => (
          <p class="sign-in-error" role="alert">
            {msg()}
          </p>
        )}
      </Show>
      <p class="sign-in-terms">
        続行することで{" "}
        <a
          href="https://docs.takos.jp/legal/terms-of-service"
          class="link"
          target="_blank"
          rel="noopener"
        >
          利用規約
        </a>{" "}
        と
        <a
          href="https://docs.takos.jp/legal/privacy-policy"
          class="link"
          target="_blank"
          rel="noopener"
        >
          プライバシーポリシー
        </a>{" "}
        に同意したものとみなします。
      </p>
    </div>
  );
}

/** Sign-in page wrapper (brand + panel). */
export function SignInView() {
  useDocumentTitle("サインイン");
  return (
    <div class="auth-page">
      <InkBackdrop density="auth" />
      <a href="/" class="auth-brand">
        <InkdropMark size={32} />
        <span class="auth-brand-text">Takosumi</span>
      </a>
      <SignInPanel />
    </div>
  );
}

/**
 * OAuth callback handler. Completes the upstream OAuth round-trip, refreshes the
 * cookie session, then navigates to the preserved return path.
 *
 * API: GET /v1/auth/upstream/callback (via rpc.auth.completeUpstreamOAuth).
 */
export function SignInCallbackView() {
  useDocumentTitle("サインイン処理中...");
  const nav = useNavigate();
  const [params] = useSearchParams<{
    code?: string;
    state?: string;
    provider?: string;
  }>();
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    const code = params.code;
    const state = params.state;
    // Upstream providers don't pass `provider` back in the URL — recall it
    // from sessionStorage (stashed by startUpstreamOAuth) and fall back to the
    // URL only if the SPA initiated the flow via a deep link.
    const provider =
      (params.provider as "google" | "github" | undefined) ??
      rpc.auth.recallOAuthProvider() ??
      undefined;
    if (typeof code !== "string" || typeof state !== "string" || !provider) {
      setError(
        "OAuth response が不完全です (code / state / provider のいずれかが欠落)。 再度 sign-in を試してください。",
      );
      return;
    }
    rpc.auth
      .completeUpstreamOAuth(code, state, provider)
      .then(async ({ returnTo }: { returnTo: string }) => {
        // Populate the session cache from the just-set HttpOnly cookie BEFORE
        // we navigate; otherwise the next route's AuthGuard runs before the
        // /me roundtrip resolves and bounces back to /sign-in.
        await refreshSession();
        nav(returnTo, { replace: true });
      })
      .catch((err: Error) => setError(err.message));
  });

  return (
    <div class="auth-page">
      <Show
        when={!error()}
        fallback={
          <div class="sign-in-panel">
            <h1 class="sign-in-title">サインインに失敗しました</h1>
            <p class="sign-in-error" role="alert">
              {error()}
            </p>
            <a
              href="/sign-in"
              class="btn btn-secondary"
              style="margin-top: 24px;"
            >
              サインインへ戻る
            </a>
          </div>
        }
      >
        <p class="auth-spinner">サインイン処理中...</p>
      </Show>
    </div>
  );
}

// ===========================================================================
// Takos start (product launch)
// ===========================================================================

const DEFAULT_USE_TAKOS_TERMS_VERSION = "terms-2026-05-13";

interface UseTakosStartUrlInput {
  readonly origin: string;
  readonly takosUrl: string;
  readonly subject: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly appId?: string;
  readonly termsVersion?: string;
  readonly returnTo?: string;
}

/**
 * Resolve the default Takos product URL for the current host. On a local
 * substrate hostname we point at `https://takos.test`; otherwise it can be set
 * via the build-time `VITE_TAKOSUMI_DASHBOARD_TAKOS_URL`. Returns `undefined`
 * when nothing is configured (the form then requires the user to type it).
 *
 * NOTE (simplify): in the single-operator merged world the Takos product URL is
 * the same origin family as the account plane; a follow-up can hardcode this
 * instead of reading per-distribution env.
 */
function tryDefaultTakosUrlForHost(hostname: string): string | undefined {
  if (isLocalHost(hostname)) return "https://takos.test";
  const configured = (
    import.meta.env.VITE_TAKOSUMI_DASHBOARD_TAKOS_URL as string | undefined
  )?.trim();
  if (configured) return configured;
  return undefined;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname.endsWith(".test") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function safeReturnTo(value: string | undefined, spaceId: string): string {
  if (value?.startsWith("/") && !value.startsWith("//")) return value;
  return `/spaces/${spaceId}/threads`;
}

function buildUseTakosStartUrl(input: UseTakosStartUrlInput): string {
  const url = new URL("/start", input.origin);
  url.searchParams.set("takos_url", input.takosUrl);
  url.searchParams.set("subject", input.subject);
  url.searchParams.set("account_id", input.accountId);
  url.searchParams.set("space_id", input.spaceId);
  if (input.installationId) {
    url.searchParams.set("installation_id", input.installationId);
  }
  if (input.appId) {
    url.searchParams.set("app_id", input.appId);
  }
  url.searchParams.set(
    "terms_version",
    input.termsVersion ?? DEFAULT_USE_TAKOS_TERMS_VERSION,
  );
  url.searchParams.set("terms_accepted", "true");
  url.searchParams.set(
    "return_to",
    safeReturnTo(input.returnTo, input.spaceId),
  );
  return url.toString();
}

/**
 * Takos product launch screen. Confirms account / space / terms, then redirects
 * to the `/start` launch URL. `use-takos-start` ports here as a local helper.
 */
export function TakosStartView() {
  useDocumentTitle("Start Takos");
  return (
    <Page>
      {(session: SessionRecord) => (
        <TakosStartInner subject={session.subject} />
      )}
    </Page>
  );
}

function TakosStartInner(props: { subject: string }) {
  const [params] = useSearchParams<{
    takos_url?: string;
    takosUrl?: string;
    account_id?: string;
    accountId?: string;
    space_id?: string;
    spaceId?: string;
    installation_id?: string;
    installationId?: string;
    app_id?: string;
    appId?: string;
    terms_version?: string;
    termsVersion?: string;
    return_to?: string;
    returnTo?: string;
  }>();
  const host = typeof location === "undefined" ? "" : location.hostname;
  const origin =
    typeof location === "undefined"
      ? "https://app.takosumi.com"
      : location.origin;
  const storage =
    typeof localStorage === "undefined" ? undefined : localStorage;

  const [takosUrl, setTakosUrl] = createSignal(
    params.takos_url ??
      params.takosUrl ??
      tryDefaultTakosUrlForHost(host) ??
      "",
  );
  const [accountId, setAccountId] = createSignal(
    params.account_id ??
      params.accountId ??
      storage?.getItem("tg_apps_account_id") ??
      "",
  );
  const [spaceId, setSpaceId] = createSignal(
    params.space_id ??
      params.spaceId ??
      storage?.getItem("tg_apps_space_id") ??
      "",
  );
  const [termsVersion, setTermsVersion] = createSignal(
    params.terms_version ??
      params.termsVersion ??
      DEFAULT_USE_TAKOS_TERMS_VERSION,
  );
  const [termsAccepted, setTermsAccepted] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const submit = (event: Event) => {
    event.preventDefault();
    setErr(null);
    if (!accountId() || !spaceId()) {
      setErr("Account ID と Space ID を入力してください。");
      return;
    }
    if (!termsAccepted()) {
      setErr("利用規約への同意が必要です。");
      return;
    }
    storage?.setItem("tg_apps_account_id", accountId());
    storage?.setItem("tg_apps_space_id", spaceId());
    location.assign(
      buildUseTakosStartUrl({
        origin,
        takosUrl: takosUrl(),
        subject: props.subject,
        accountId: accountId(),
        spaceId: spaceId(),
        installationId: params.installation_id ?? params.installationId,
        appId: params.app_id ?? params.appId,
        termsVersion: termsVersion(),
        returnTo: params.return_to ?? params.returnTo,
      }),
    );
  };

  return (
    <AppShell>
      <DPageHeader
        eyebrow="Launch"
        title="Use Takos"
        subtitle="Account と Space を確認して、Takos を開始します。"
      />

      <form class="wave-d-stack" onSubmit={submit}>
        <DCard>
          <DCardHeader title="Takos launch" />
          <DCardSection>
            <div class="wave-d-field-grid">
              <DFormField label="Takos URL" required>
                <DInput
                  type="url"
                  value={takosUrl()}
                  onInput={(e) => setTakosUrl(e.currentTarget.value)}
                  required
                />
              </DFormField>
              <DFormField label="Terms version" required>
                <DInput
                  type="text"
                  value={termsVersion()}
                  onInput={(e) => setTermsVersion(e.currentTarget.value)}
                  required
                />
              </DFormField>
            </div>
          </DCardSection>
        </DCard>

        <DCard>
          <DCardHeader title="Account and Space" />
          <DCardSection>
            <div class="wave-d-field-grid">
              <DFormField label="Account ID" required>
                <DInput
                  type="text"
                  value={accountId()}
                  onInput={(e) => setAccountId(e.currentTarget.value)}
                  placeholder="acct_xxxxx"
                  required
                />
              </DFormField>
              <DFormField label="Space ID" required>
                <DInput
                  type="text"
                  value={spaceId()}
                  onInput={(e) => setSpaceId(e.currentTarget.value)}
                  placeholder="space_xxxxx"
                  required
                />
              </DFormField>
            </div>
          </DCardSection>
        </DCard>

        <DCard>
          <DCardHeader title="Terms" />
          <DCardSection>
            <DCheckbox
              checked={termsAccepted()}
              onChange={(e) => setTermsAccepted(e.currentTarget.checked)}
              label="Takosumi の利用規約に同意します。"
            />
            <Show when={err()}>
              {(m) => (
                <p class="wave-d-error" role="alert">
                  {m()}
                </p>
              )}
            </Show>
            <div class="wave-d-actions">
              <DButton
                variant="primary"
                type="submit"
                disabled={
                  !accountId() || !spaceId() || !takosUrl() || !termsAccepted()
                }
                icon={<Icons.Play class="w-4 h-4" />}
              >
                Launch Takos
              </DButton>
            </div>
          </DCardSection>
        </DCard>
      </form>
    </AppShell>
  );
}

// ===========================================================================
// Home / Notifications / index — read GET /v1/account/session/me only
// ===========================================================================

/** Account-plane landing for an authenticated user. */
export function HomeView() {
  return (
    <Page title="Home">
      {(session: SessionRecord) => (
        <AppShell>
          <PageHeader
            eyebrow="Home"
            title="おかえりなさい"
            subtitle={
              <SignedInAs
                name={session.displayName}
                sub={session.subject}
                email={session.email}
              />
            }
          />
          <EmptyState
            ink
            icon={<Icons.Package />}
            title="まだアプリがありません"
            message="Git URL から OpenTofu Capsule を導入すると、ここに表示されます。"
            action={
              <Button variant="primary" href="/install" icon={<Icons.Plus />}>
                Git URL から導入
              </Button>
            }
          />
        </AppShell>
      )}
    </Page>
  );
}

function SignedInAs(props: { name?: string; sub: string; email?: string }) {
  if (props.name)
    return (
      <>
        Signed in as {props.name} ({props.sub})
      </>
    );
  if (props.email)
    return (
      <>
        Signed in as {props.email} ({props.sub})
      </>
    );
  return <>Signed in as {props.sub}</>;
}

// ===========================================================================
// Notifications — the in-app activity / notification feed
// ===========================================================================

/**
 * Notifications view (`/notifications`). A plain-language activity feed for the
 * signed-in person, aggregated across every Space they belong to. It reads the
 * Space-scoped audit trail the control surface already exposes
 * (`GET /api/v1/spaces/:id/activity`, via the `listActivity` client fn) for
 * each of the visitor's Spaces, merges the events, and shows them newest-first.
 *
 * Unlike the operator-facing ControlActivityView (which shows raw action verbs
 * and `targetType · targetId`), this feed translates each event into a single
 * everyday-Japanese sentence and surfaces failures prominently: a failed run
 * (`run.failed`) or detected drift gets a danger treatment so a non-expert
 * notices "something needs my attention" without reading internal jargon.
 *
 * Honesty: the feed only renders values the backend already recorded as
 * public-safe Activity metadata (names, ids, counts, a compact error CODE). It
 * invents no prices, no credit-cost formula, and no message the server did not
 * emit — failed events show the server's compact `errorCode`, never a raw
 * diagnostic.
 */

/** Max events fetched per Space and rendered in the merged feed. */
const NOTIF_PER_SPACE_LIMIT = 50;
const NOTIF_FEED_LIMIT = 60;

/** An ActivityEvent plus the Space it came from (for cross-Space labelling). */
interface FeedEntry {
  readonly event: ActivityEvent;
  readonly spaceHandle: string;
}

/** Actions we treat as failures / needs-attention (danger styling). */
function isFailureAction(action: string): boolean {
  return (
    action === "run.failed" ||
    action === "installation.drift_detected" ||
    action === "connection.revoked"
  );
}

function metaString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = metadata[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function metaNumber(
  metadata: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = metadata[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Translate an operation code (`plan` / `apply` / `destroy_apply` …) into a
 * short everyday-Japanese noun. Falls back to the raw code so an unknown
 * operation still renders truthfully rather than disappearing.
 */
function operationLabel(operation: string | undefined): string {
  switch (operation) {
    case "plan":
      return "プラン作成";
    case "apply":
      return "適用";
    case "destroy_plan":
      return "削除プラン";
    case "destroy_apply":
      return "削除の適用";
    case "drift_check":
      return "ズレ確認";
    case "source_sync":
      return "ソース取得";
    default:
      return operation ?? "操作";
  }
}

/**
 * One plain-language sentence describing the event, using ONLY metadata the
 * backend already recorded. Returns a title (the headline) and an optional
 * detail line (extra context, never secrets).
 */
function describeEvent(event: ActivityEvent): {
  readonly title: string;
  readonly detail?: string;
} {
  const m = event.metadata ?? {};
  switch (event.action) {
    case "installation.created": {
      const name = metaString(m, "name") ?? "アプリ";
      const env = metaString(m, "environment");
      return {
        title: `アプリ「${name}」を追加しました`,
        detail: env ? `環境: ${env}` : undefined,
      };
    }
    case "run.plan_created": {
      return {
        title: `${operationLabel(metaString(m, "operation"))}の準備ができました`,
        detail:
          metaString(m, "policyStatus") === "blocked"
            ? "ポリシーにより承認が止まっています"
            : "内容を確認して承認できます",
      };
    }
    case "run.approved": {
      return {
        title: `${operationLabel(metaString(m, "operation"))}を承認しました`,
      };
    }
    case "run.applied": {
      const outputs = metaNumber(m, "outputCount");
      return {
        title: "アプリの変更を反映しました",
        detail:
          outputs !== undefined ? `出力 ${outputs} 件を更新` : undefined,
      };
    }
    case "run.destroyed": {
      return { title: "アプリを削除しました" };
    }
    case "run.failed": {
      const code = metaString(m, "errorCode");
      return {
        title: `${operationLabel(metaString(m, "phase"))}に失敗しました`,
        detail: code ? `エラー: ${code}` : "詳細は実行ログを確認してください",
      };
    }
    case "installation.drift_detected": {
      return {
        title: "アプリの実状態が記録とズレています",
        detail: "再適用が必要かもしれません",
      };
    }
    case "installation.stale": {
      const producer = metaString(m, "producerInstallationName");
      return {
        title: "依存先の更新で再適用が必要になりました",
        detail: producer ? `更新元: ${producer}` : undefined,
      };
    }
    case "connection.created": {
      const provider = metaString(m, "provider");
      return {
        title: provider
          ? `接続「${provider}」を追加しました`
          : "接続を追加しました",
      };
    }
    case "connection.revoked": {
      const provider = metaString(m, "provider");
      return {
        title: provider
          ? `接続「${provider}」が無効になりました`
          : "接続が無効になりました",
      };
    }
    case "backup.created": {
      return { title: "バックアップを作成しました" };
    }
    case "dependency.created": {
      return { title: "アプリ間の連携を追加しました" };
    }
    case "dependency.deleted": {
      return { title: "アプリ間の連携を解除しました" };
    }
    case "output_share.created": {
      return { title: "出力の共有リクエストが届きました" };
    }
    case "output_share.approved": {
      return { title: "出力の共有を承認しました" };
    }
    case "output_share.revoked": {
      return { title: "出力の共有を取り消しました" };
    }
    case "run_group.created": {
      return { title: "まとめての更新を開始しました" };
    }
    default: {
      // Unknown action: stay truthful and show the raw verb rather than guess.
      return { title: event.action };
    }
  }
}

/** Relative time in plain Japanese ("たった今" / "5分前" / a date for old items). */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 45) return "たった今";
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}分前`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}時間前`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}日前`;
  return new Date(then).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Load every Space's recent activity and merge it into one newest-first feed. */
async function loadNotificationFeed(
  spaces: readonly Space[],
): Promise<readonly FeedEntry[]> {
  const perSpace = await Promise.all(
    spaces.map(async (space): Promise<readonly FeedEntry[]> => {
      const events = await listActivity(space.id, NOTIF_PER_SPACE_LIMIT);
      return events.map((event) => ({
        event,
        spaceHandle: space.handle,
      }));
    }),
  );
  return perSpace
    .flat()
    .sort((a, b) => Date.parse(b.event.createdAt) - Date.parse(a.event.createdAt))
    .slice(0, NOTIF_FEED_LIMIT);
}

function NotificationRow(props: { entry: FeedEntry }) {
  const failure = () => isFailureAction(props.entry.event.action);
  const description = () => describeEvent(props.entry.event);
  return (
    <li class={`wc-notif-row${failure() ? " wc-notif-row-failure" : ""}`}>
      <span class="wc-notif-icon" aria-hidden="true">
        <Show when={failure()} fallback={<Icons.Bell />}>
          <Icons.AlertTriangle />
        </Show>
      </span>
      <div class="wc-notif-body">
        <p class="wc-notif-title">
          <Show when={failure()}>
            <Badge tone="danger">要対応</Badge>
          </Show>
          {description().title}
        </p>
        <Show when={description().detail}>
          {(detail) => <p class="wc-notif-detail">{detail()}</p>}
        </Show>
        <p class="wc-notif-foot">
          <span>@{props.entry.spaceHandle}</span>
          <span aria-hidden="true">·</span>
          <time datetime={props.entry.event.createdAt}>
            {relativeTime(props.entry.event.createdAt)}
          </time>
        </p>
      </div>
    </li>
  );
}

export function NotificationsView() {
  return (
    <Page title="通知">
      {() => {
        const [spaces] = createResource(listSpaces);
        const [feed] = createResource(
          () => spaces(),
          (list) => loadNotificationFeed(list),
        );
        const loading = () => spaces.loading || feed.loading;
        const error = createMemo(
          () =>
            (spaces.error as ControlApiError | undefined) ??
            (feed.error as ControlApiError | undefined),
        );
        const failureCount = () =>
          (feed() ?? []).filter((e) => isFailureAction(e.event.action)).length;

        return (
          <AppShell>
            <PageHeader
              eyebrow="Notifications"
              title="通知"
              subtitle="追加・実行・承認・失敗など、あなたの Space での出来事を新しい順に表示します。"
            />

            <Switch>
              <Match when={loading()}>
                <Skeleton variant="card" count={3} />
              </Match>
              <Match when={error()}>
                <Toast tone="error">
                  通知を読み込めませんでした — {error()?.message}
                </Toast>
              </Match>
              <Match when={feed()}>
                {(list) => (
                  <Show
                    when={list().length > 0}
                    fallback={
                      <EmptyState
                        ink
                        icon={<Icons.Bell />}
                        title="まだ通知はありません"
                        message="アプリを追加したり実行したりすると、ここに出来事が並びます。"
                      />
                    }
                  >
                    <div class="wc-stack-sm">
                      <Show when={failureCount() > 0}>
                        <p class="wc-notif-summary">
                          <Icons.AlertTriangle aria-hidden="true" />
                          要対応の出来事が {failureCount()} 件あります。
                        </p>
                      </Show>
                      <ul class="wc-notif-list">
                        <For each={list()}>
                          {(entry) => <NotificationRow entry={entry} />}
                        </For>
                      </ul>
                    </div>
                  </Show>
                )}
              </Match>
            </Switch>
          </AppShell>
        );
      }}
    </Page>
  );
}

/**
 * Account-plane index. No marketing landing on the account plane — probe the
 * server-side session via /v1/account/session/me (the cookie is HttpOnly and
 * cannot be read from JS) and send the visitor to /home or /sign-in.
 */
export function AccountIndexView() {
  const nav = useNavigate();

  onMount(() => {
    void refreshSession().then((session: SessionRecord | null) => {
      nav(session ? "/home" : "/sign-in", { replace: true });
    });
  });

  return (
    <div class="auth-page">
      <p class="auth-spinner">読み込み中...</p>
    </div>
  );
}

// ===========================================================================
// Local helpers (InstallWizard)
// ===========================================================================

function storedValue(key: string): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  const value = localStorage.getItem(key);
  return value && value.length > 0 ? value : undefined;
}

function generatedId(prefix: "space" | "acct"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function pickString(
  obj: Record<string, unknown>,
  paths: string[],
): string | null {
  for (const p of paths) {
    const v = lookupPath(obj, p);
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function lookupPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (
      cur &&
      typeof cur === "object" &&
      k in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}
