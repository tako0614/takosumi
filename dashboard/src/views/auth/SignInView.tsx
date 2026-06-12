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
import { createSignal, type JSX, onMount, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import InkBackdrop from "../../components/ui/InkBackdrop.tsx";
import InkdropMark from "../account/components/brand/InkdropMark.tsx";
import { rpc } from "../account/lib/api.ts";
import { refreshSession } from "../account/lib/session.ts";
import { setDocumentTitle, t } from "../../i18n/index.ts";

type Provider = "google" | "github";

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
    name: "GitHub",
    icon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.32-1.28-1.67-1.28-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.07.78 2.15v3.18c0 .31.21.68.8.56C20.21 21.38 23.5 17.07 23.5 12 23.5 5.65 18.35.5 12 .5z" />
      </svg>
    ),
  },
];

export function SignInPanel() {
  // Start all-disabled and flip on by operator config: failing closed means we
  // never briefly render an enabled button that the backend would 503.
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
        // Availability unreadable → every method stays disabled with the
        // "operator not configured" hint instead of a button that would 503.
      });
  });

  const isEnabled = (p: Provider): boolean => enabled()[p] === true;

  const select = (p: Provider) => {
    if (!isEnabled(p)) return;
    rpc.auth.startUpstreamOAuth(p);
  };

  return (
    <div class="sign-in-panel">
      <h1 class="sign-in-title">{t("auth.signIn")}</h1>
      <p class="sign-in-sub">{t("auth.signInSub")}</p>
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
              <span class="sign-in-sub-text">
                {isEnabled(p.id) ? "OAuth 2.0" : t("auth.notConfigured")}
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
      <p class="sign-in-terms">
        {/* TODO(brand): these legal documents live on the takos product docs
            site today; takosumi has no published terms/privacy pages yet.
            Repoint when takosumi-branded legal pages exist. */}
        {t("auth.termsPrefix")}{" "}
        <a
          href="https://docs.takos.jp/legal/terms-of-service"
          class="link"
          target="_blank"
          rel="noopener"
        >
          {t("auth.termsOfService")}
        </a>
        {t("auth.and")}
        <a
          href="https://docs.takos.jp/legal/privacy-policy"
          class="link"
          target="_blank"
          rel="noopener"
        >
          {t("auth.privacyPolicy")}
        </a>
        {t("auth.termsSuffix")}
      </p>
    </div>
  );
}

/** Sign-in page wrapper (brand + panel). */
export default function SignInView() {
  onMount(() => setDocumentTitle(t("auth.signIn")));
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
      setError(t("auth.incompleteCallback"));
      return;
    }
    rpc.auth
      .completeUpstreamOAuth(code, state, provider)
      .then(async ({ returnTo }: { returnTo: string }) => {
        // Populate the session cache from the just-set HttpOnly cookie BEFORE
        // navigating; otherwise the next route's AuthGuard runs before the
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
            <h1 class="sign-in-title">{t("auth.failed")}</h1>
            <p class="sign-in-error" role="alert">
              {error()}
            </p>
            <a
              href="/sign-in"
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
