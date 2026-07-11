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
import { createEffect, createSignal, type JSX, onMount, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { Monitor, Moon, Sun } from "lucide-solid";
import { installReturnContext } from "../../lib/install-return-context.ts";
import {
  setThemePreference,
  themePreference,
  type ThemePreference,
} from "../../lib/theme.ts";
import {
  dashboardProductName,
  isTakosumiCloudRuntime,
} from "../../lib/deployment-brand.ts";
import type { MessageKey } from "../../i18n/index.ts";
import { rpc } from "../account/lib/api.ts";
import { refreshSession } from "../account/lib/session.ts";
import LogoMark from "../account/components/brand/LogoMark.tsx";
import { setDocumentTitle, t } from "../../i18n/index.ts";

type Provider = "google";

interface ProviderInfo {
  id: Provider;
  name: string;
  icon: () => JSX.Element;
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: "google",
    name: "Google",
    icon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#4285f4"
          d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4c-.2 1.3-1 2.4-2 3.1v2.6h3.3c2-1.8 3-4.5 3-7.5z"
        />
        <path
          fill="#34a853"
          d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.6c-.9.6-2.1 1-3.4 1-2.6 0-4.9-1.8-5.7-4.2H3v2.6C4.7 19.7 8.1 22 12 22z"
        />
        <path
          fill="#fbbc05"
          d="M6.3 13.8c-.2-.6-.3-1.2-.3-1.8s.1-1.2.3-1.8V7.6H3C2.4 8.9 2 10.4 2 12s.4 3.1 1 4.4l3.3-2.6z"
        />
        <path
          fill="#ea4335"
          d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9C16.9 2.9 14.7 2 12 2 8.1 2 4.7 4.3 3 7.6l3.3 2.6c.8-2.4 3.1-4.3 5.7-4.3z"
        />
      </svg>
    ),
  },
];

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
// cookie doesn't persist. We record one auto-start attempt per browser session
// (survives the full-page OAuth redirect via sessionStorage) and refuse to
// auto-start again until a real sign-in clears it.
const OAUTH_AUTOSTART_KEY = "takosumi.oauth-autostart-attempted";
function autoStartAlreadyAttempted(): boolean {
  try {
    return sessionStorage.getItem(OAUTH_AUTOSTART_KEY) === "1";
  } catch {
    return false;
  }
}
function markAutoStartAttempted(): void {
  try {
    sessionStorage.setItem(OAUTH_AUTOSTART_KEY, "1");
  } catch {
    // sessionStorage unavailable — manual=1 on the retry link is the fallback.
  }
}
function clearAutoStartAttempt(): void {
  try {
    sessionStorage.removeItem(OAUTH_AUTOSTART_KEY);
  } catch {
    // ignore
  }
}

export function SignInPanel() {
  const [params] = useSearchParams<{
    return?: string;
    return_to?: string;
    manual?: string;
  }>();
  // Start all-disabled and flip on by operator config: failing closed means we
  // never briefly render an enabled button that the backend would 503.
  const [enabled, setEnabled] = createSignal<Record<string, boolean>>({});
  const [providersLoaded, setProvidersLoaded] = createSignal(false);
  const [providersLoadFailed, setProvidersLoadFailed] = createSignal(false);
  const [autoStarted, setAutoStarted] = createSignal(false);

  const loadProviders = () => {
    setProvidersLoaded(false);
    setProvidersLoadFailed(false);
    setEnabled({});
    void rpc.auth
      .listProviders()
      .then((res) => {
        const map: Record<string, boolean> = {};
        for (const provider of res.providers) {
          map[provider.id] = provider.enabled;
        }
        setEnabled(map);
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

  const isEnabled = (p: Provider): boolean => enabled()[p] === true;
  const enabledProviders = (): readonly Provider[] =>
    PROVIDERS.filter((p) => isEnabled(p.id)).map((p) => p.id);
  const hasEnabledProvider = (): boolean =>
    PROVIDERS.some((p) => isEnabled(p.id));
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
    if (!isTakosumiCloudRuntime()) return false;
    if (params.manual === "1") return false;
    // A prior auto-start this browser session that never landed us signed in
    // (OAuth failure, or a session cookie that didn't persist so AuthGuard
    // bounced us back here) must not silently re-fire — that is an inescapable
    // redirect loop. Fall back to the manual provider buttons instead.
    if (autoStartAlreadyAttempted()) return false;
    if (!providersLoaded() || providersLoadFailed()) return false;
    const ids = enabledProviders();
    return ids.length === 1 && ids[0] === "google";
  };

  createEffect(() => {
    if (autoStarted() || !shouldAutoStart()) return;
    setAutoStarted(true);
    markAutoStartAttempted();
    select("google");
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
      <h1 class="sign-in-title">
        {t(isTakosumiCloudRuntime() ? "auth.signInCloud" : "auth.signIn")}
      </h1>
      <p class="sign-in-sub">
        {t(isTakosumiCloudRuntime() ? "auth.signInSubCloud" : "auth.signInSub")}
      </p>
      <Show when={isTakosumiCloudRuntime()}>
        <p class="sign-in-preview-note">{t("auth.signInCloudPreview")}</p>
      </Show>
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
              <span class="sign-in-label">
                {t("auth.continueWith", { provider: p.name })}
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
      <Show when={isTakosumiCloudRuntime()}>
        <p class="sign-in-terms">
          {/* No hardcoded space between fragments: JA joins without one and
              the EN values carry their own spacing. */}
          {t("auth.termsPrefix")}
          <a href="/legal/terms-of-service" class="link">
            {t("auth.termsOfService")}
          </a>
          {t("auth.and")}
          <a href="/legal/privacy-policy" class="link">
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
          <span class="auth-brand-text">
            {dashboardProductName()}
            <Show when={isTakosumiCloudRuntime()}>
              <span class="auth-brand-sub">Cloud</span>
            </Show>
          </span>
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
      (params.provider as Provider | undefined) ??
      rpc.auth.recallOAuthProvider() ??
      undefined;
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
