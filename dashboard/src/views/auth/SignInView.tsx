/**
 * Sign-in (upstream OAuth) + OAuth callback — rebuilt from the legacy
 * AccountMiscViews port, i18n-ed.
 *
 * Which providers are clickable is resolved at runtime from
 * `GET /v1/auth/providers` (operator config) and fails closed, so a button
 * whose backend would answer 503 is never enabled. The permanently-disabled
 * passkey placeholder of the old screen is intentionally NOT carried over:
 * the dashboard ships no WebAuthn client yet, and a control that can never
 * work reads as broken. It returns together with the client.
 */
import {
  createEffect,
  createResource,
  createSignal,
  type JSX,
  onMount,
  Show,
} from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { LogIn, Monitor, Moon, Sun } from "lucide-solid";
import type { TakosumiAccountsAuthProvider } from "@takosjp/takosumi-accounts-contract";
import { installReturnContext } from "../../lib/install-return-context.ts";
import {
  loadPlatformContributions,
  platformContributionsForSlot,
} from "../../lib/platform-contributions.ts";
import {
  setThemePreference,
  themePreference,
  type ThemePreference,
} from "../../lib/theme.ts";
import { dashboardProductName } from "../../lib/runtime-capabilities.ts";
import type { MessageKey } from "../../i18n/index.ts";
import { rpc } from "../account/lib/api.ts";
import {
  autoStartAlreadyAttempted,
  clearAutoStartAttempt,
  markAutoStartAttempted,
} from "../account/lib/oauth-autostart.ts";
import { refreshSession } from "../account/lib/session.ts";
import LogoMark from "../account/components/brand/LogoMark.tsx";
import { setDocumentTitle, t } from "../../i18n/index.ts";

type Provider = string;

const THEME_LABEL_KEY: Record<ThemePreference, MessageKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};

const THEME_ICON: Record<ThemePreference, () => JSX.Element> = {
  system: () => <Monitor size={16} aria-hidden="true" />,
  light: () => <Sun size={16} aria-hidden="true" />,
  dark: () => <Moon size={16} aria-hidden="true" />,
};

// Cloud single-provider auto-start is convenient but must not become an
// inescapable redirect loop when the OAuth round-trip fails or the session
// cookie doesn't persist, and it must never re-sign-in someone who just signed
// out. The breaker (one auto-start attempt per browser session, surviving the
// full-page OAuth redirect via sessionStorage) is owned by `lib/auth.ts` so the
// sign-out handlers can arm it too.
export function SignInPanel() {
  const [platformContributions] = createResource(loadPlatformContributions);
  const termsContribution = () =>
    platformContributionsForSlot(platformContributions(), "legal.terms")[0];
  const privacyContribution = () =>
    platformContributionsForSlot(platformContributions(), "legal.privacy")[0];
  const [params] = useSearchParams<{
    return?: string;
    return_to?: string;
    manual?: string;
  }>();
  // Start all-disabled and flip on by operator config: failing closed means we
  // never briefly render an enabled button that the backend would 503.
  const [providers, setProviders] = createSignal<
    readonly TakosumiAccountsAuthProvider[]
  >([]);
  const [providersLoaded, setProvidersLoaded] = createSignal(false);
  const [providersLoadFailed, setProvidersLoadFailed] = createSignal(false);
  const [autoStarted, setAutoStarted] = createSignal(false);

  const loadProviders = () => {
    setProvidersLoaded(false);
    setProvidersLoadFailed(false);
    setProviders([]);
    void rpc.auth
      .listProviders()
      .then((res) => {
        setProviders(res.providers.filter(isDashboardOAuthProvider));
        setProvidersLoaded(true);
      })
      .catch(() => {
        // Availability unreadable → every method stays disabled with the
        // retry hint instead of a button that would 503.
        setProvidersLoadFailed(true);
        setProvidersLoaded(true);
      });
  };

  onMount(loadProviders);

  const isEnabled = (p: Provider): boolean =>
    providers().some((provider) => provider.id === p && provider.enabled);
  const enabledProviders = (): readonly TakosumiAccountsAuthProvider[] =>
    providers().filter((provider) => provider.enabled);
  const hasEnabledProvider = (): boolean =>
    providers().some((provider) => provider.enabled);
  const providerSubText = (p: Provider): string | undefined => {
    if (!providersLoaded()) return t("auth.providerChecking");
    if (providersLoadFailed()) return t("auth.providerRetryNeeded");
    return isEnabled(p) ? undefined : t("auth.providerUnavailable");
  };

  const select = (p: Provider) => {
    if (!isEnabled(p)) return;
    rpc.auth.startUpstreamOAuth(p);
  };
  const shouldAutoStart = (): boolean => {
    if (params.manual === "1") return false;
    // A prior auto-start this browser session that never landed us signed in
    // (OAuth failure, or a session cookie that didn't persist so AuthGuard
    // bounced us back here) must not silently re-fire — that is an inescapable
    // redirect loop. Fall back to the manual provider buttons instead.
    if (autoStartAlreadyAttempted()) return false;
    if (!providersLoaded() || providersLoadFailed()) return false;
    return enabledProviders().length === 1;
  };

  createEffect(() => {
    if (autoStarted() || !shouldAutoStart()) return;
    const provider = enabledProviders()[0];
    if (!provider) return;
    setAutoStarted(true);
    markAutoStartAttempted();
    select(provider.id);
  });

  const returnParam = () => params.return || params.return_to;
  const pendingInstall = () => installReturnContext(returnParam());
  const pendingInstallDetails = () => {
    const ctx = pendingInstall();
    if (!ctx) return "";
    return [
      ctx.displayRef
        ? t("auth.installContextRef", { ref: ctx.displayRef })
        : t("auth.installContextDefaultRef"),
      ctx.path || t("auth.installContextRootPath"),
    ].join(" / ");
  };
  const noProvidersMessage = () =>
    t(
      pendingInstall()
        ? "auth.noProvidersMessageWithInstall"
        : "auth.noProvidersMessage",
    );
  const providersLoadFailedMessage = () =>
    t(
      pendingInstall()
        ? "auth.providersLoadFailedMessageWithInstall"
        : "auth.providersLoadFailedMessage",
    );

  return (
    <div class="sign-in-panel">
      <h1 class="sign-in-title">{dashboardProductName()}</h1>
      <p class="sign-in-sub">{t("auth.signInSub")}</p>
      <Show when={pendingInstall()}>
        <div
          class="sign-in-return-context"
          aria-label={t("auth.installContextAria")}
        >
          <span class="sign-in-return-kicker">
            {t("auth.installContextKicker")}
          </span>
          <strong class="sign-in-return-title">
            {pendingInstall()?.label ?? t("auth.installContextTitle")}
          </strong>
          <span class="sign-in-return-detail">{pendingInstallDetails()}</span>
        </div>
      </Show>
      <div class="sign-in-buttons">
        {providers().map((p) => (
          <button
            type="button"
            class="sign-in-btn"
            data-provider={p.id}
            disabled={!isEnabled(p.id)}
            onClick={() => select(p.id)}
          >
            <span class="sign-in-icon">
              <LogIn size={20} aria-hidden="true" />
            </span>
            <span class="sign-in-text">
              <span class="sign-in-label">
                {t("auth.continueWith", {
                  provider: p.label?.trim() || t("auth.singleSignOn"),
                })}
              </span>
              <Show when={providerSubText(p.id)}>
                {(subText) => <span class="sign-in-sub-text">{subText()}</span>}
              </Show>
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
      {/* Persistent polite region: both notices below are conditionally
          mounted, and a role=status inserted together with its text can go
          unannounced. Announce whichever notice is active here, and leave the
          visible boxes as plain (roleless) content. */}
      <p class="sr-only" role="status" aria-live="polite">
        <Show when={providersLoaded() && providersLoadFailed()}>
          {t("auth.providersLoadFailedTitle")} {providersLoadFailedMessage()}
        </Show>
        <Show
          when={
            providersLoaded() && !providersLoadFailed() && !hasEnabledProvider()
          }
        >
          {t("auth.noProvidersTitle")} {noProvidersMessage()}
        </Show>
      </p>
      <Show when={providersLoaded() && providersLoadFailed()}>
        <div class="sign-in-notice sign-in-notice-warn">
          <strong>{t("auth.providersLoadFailedTitle")}</strong>
          <span>{providersLoadFailedMessage()}</span>
          <button type="button" class="sign-in-retry" onClick={loadProviders}>
            {t("auth.retryProviderCheck")}
          </button>
        </div>
      </Show>
      <Show
        when={
          providersLoaded() && !providersLoadFailed() && !hasEnabledProvider()
        }
      >
        <div class="sign-in-notice">
          <strong>{t("auth.noProvidersTitle")}</strong>
          <span>{noProvidersMessage()}</span>
          <button type="button" class="sign-in-retry" onClick={loadProviders}>
            {t("auth.retryProviderCheck")}
          </button>
        </div>
      </Show>
      <Show when={termsContribution() && privacyContribution()}>
        <p class="sign-in-terms">
          {/* No hardcoded space between fragments: JA joins without one and
              the EN values carry their own spacing. */}
          {t("auth.termsPrefix")}
          <a href={termsContribution()?.href} class="link">
            {t("auth.termsOfService")}
          </a>
          {t("auth.and")}
          <a href={privacyContribution()?.href} class="link">
            {t("auth.privacyPolicy")}
          </a>
          {t("auth.termsSuffix")}
        </p>
      </Show>
    </div>
  );
}

function BrandLogoMark() {
  return (
    <span class="auth-brand-mark" aria-hidden="true">
      <LogoMark size={48} title={dashboardProductName()} />
    </span>
  );
}

function ThemeSwitcher() {
  return (
    <div class="auth-theme-switcher" role="group" aria-label={t("shell.theme")}>
      {(["system", "light", "dark"] as const).map((theme) => (
        <button
          type="button"
          class="auth-theme-btn"
          classList={{ active: themePreference() === theme }}
          aria-label={t(THEME_LABEL_KEY[theme])}
          aria-pressed={themePreference() === theme}
          title={t(THEME_LABEL_KEY[theme])}
          onClick={() => setThemePreference(theme)}
        >
          {THEME_ICON[theme]()}
        </button>
      ))}
    </div>
  );
}

/** Sign-in page wrapper (brand + panel). */
export default function SignInView() {
  onMount(() => setDocumentTitle(t("auth.signIn")));
  return (
    <main class="auth-page">
      <div class="auth-flow">
        <a href="/" class="auth-brand">
          <BrandLogoMark />
          <span class="auth-brand-text">{dashboardProductName()}</span>
        </a>
        <SignInPanel />
        <ThemeSwitcher />
      </div>
    </main>
  );
}

/**
 * OAuth callback handler. Completes the upstream OAuth round-trip, refreshes
 * the cookie session, then navigates to the preserved return path.
 */
export function SignInCallbackView() {
  onMount(() => setDocumentTitle(t("auth.processing")));
  const nav = useNavigate();
  const [params] = useSearchParams<{
    code?: string;
    state?: string;
    provider?: string;
  }>();
  const [error, setError] = createSignal<string | null>(null);
  const [retryHref, setRetryHref] = createSignal("/sign-in");
  const signInErrorMessage = (err: Error): string => {
    const message = err.message?.trim();
    if (!message || message === "oauth flow was not started in this tab") {
      return t("auth.retryableCallbackFailure");
    }
    return t("auth.retryableCallbackFailureWithDetail", { message });
  };

  onMount(() => {
    const code = params.code;
    const state = params.state;
    // Upstream providers don't pass `provider` back in the URL — recall it
    // from sessionStorage (stashed by startUpstreamOAuth) and fall back to the
    // URL only if the SPA initiated the flow via a deep link.
    const provider =
      params.provider ?? rpc.auth.recallOAuthProvider() ?? undefined;
    if (typeof code !== "string" || typeof state !== "string" || !provider) {
      setError(t("auth.retryableCallbackFailure"));
      return;
    }
    rpc.auth
      .completeUpstreamOAuth(code, state, provider)
      .then(async ({ returnTo }: { returnTo: string }) => {
        // Populate the session cache from the just-set HttpOnly cookie BEFORE
        // navigating; otherwise the next route's AuthGuard runs before the
        // /me roundtrip resolves and bounces back to /sign-in.
        await refreshSession();
        // Signed in for real — release the auto-start breaker so a later
        // sign-out → sign-in in this same tab session auto-starts once again.
        clearAutoStartAttempt();
        if (requiresDocumentNavigation(returnTo)) {
          location.assign(returnTo);
          return;
        }
        nav(returnTo, { replace: true });
      })
      .catch((err: Error) => {
        const returnTo = rpc.auth.recallOAuthReturnTo();
        // manual=1 suppresses auto-start so the retry link lands on the manual
        // provider buttons instead of instantly bouncing back into the failed
        // provider (belt-and-suspenders with the sessionStorage breaker).
        setRetryHref(
          returnTo === "/"
            ? "/sign-in?manual=1"
            : `/sign-in?return=${encodeURIComponent(returnTo)}&manual=1`,
        );
        setError(signInErrorMessage(err));
      });
  });

  return (
    <div class="auth-page">
      <Show
        when={!error()}
        fallback={
          <div class="sign-in-panel">
            <h1 class="sign-in-title">{t("auth.failed")}</h1>
            <p class="sign-in-error" role="alert">
              {error()}
            </p>
            <a
              href={retryHref()}
              class="btn btn-secondary"
              style="margin-top: 24px;"
            >
              {t("auth.backToSignIn")}
            </a>
          </div>
        }
      >
        <p class="auth-spinner">{t("auth.processing")}</p>
      </Show>
    </div>
  );
}

export function requiresDocumentNavigation(returnTo: string): boolean {
  return returnTo === "/oauth" || returnTo.startsWith("/oauth/");
}

function isDashboardOAuthProvider(
  provider: TakosumiAccountsAuthProvider,
): boolean {
  return provider.protocol.trim().toLowerCase() !== "webauthn";
}
