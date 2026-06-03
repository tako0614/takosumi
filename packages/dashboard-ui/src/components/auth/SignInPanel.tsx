import { createSignal, type JSX, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { rpc } from "~/lib/rpc";
import { shouldShowBrowserDevSignIn } from "~/lib/dev-sign-in";

type Provider = "passkey" | "google" | "github";

interface ProviderInfo {
  id: Provider;
  label: string;
  sub: string;
  enabled: boolean;
  icon: () => JSX.Element;
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: "passkey",
    label: "Passkey で続ける",
    sub: "このアカウントではまだ利用できません",
    enabled: false,
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
    enabled: true,
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
    enabled: true,
    icon: () => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.32-1.28-1.67-1.28-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.07.78 2.15v3.18c0 .31.21.68.8.56C20.21 21.38 23.5 17.07 23.5 12 23.5 5.65 18.35.5 12 .5z" />
      </svg>
    ),
  },
];

const DEV_SIGN_IN_BUILD_ENABLED = import.meta.env.DEV ||
  import.meta.env.VITE_TAKOSUMI_DASHBOARD_DEV_SIGN_IN === "true";
const DEV_SIGN_IN_SUBJECT = import.meta.env
  .VITE_TAKOSUMI_DASHBOARD_DEV_SUBJECT ?? "tsub_dev_local";
const DEV_SIGN_IN_SESSION_ID = import.meta.env
  .VITE_TAKOSUMI_DASHBOARD_DEV_SESSION_ID ?? "sess_dev_local";
const DEV_SIGN_IN_ACCOUNT_ID = import.meta.env
  .VITE_TAKOSUMI_DASHBOARD_DEV_ACCOUNT_ID ?? "acct_dev_local";
const DEV_SIGN_IN_SPACE_ID = import.meta.env
  .VITE_TAKOSUMI_DASHBOARD_DEV_SPACE_ID ?? "space_dev_local";

export default function SignInPanel() {
  const nav = useNavigate();
  const [params] = useSearchParams<{ return?: string }>();
  const [error, setError] = createSignal<string | null>(null);
  const showDevSignIn = DEV_SIGN_IN_BUILD_ENABLED &&
    shouldShowBrowserDevSignIn();

  const select = (p: Provider) => {
    setError(null);
    if (p === "passkey") {
      setError("Passkey sign-in は、このアカウントではまだ利用できません。");
      return;
    }
    rpc.auth.startUpstreamOAuth(p);
  };

  const devSignIn = DEV_SIGN_IN_BUILD_ENABLED
    ? async () => {
      const { writeSession } = await import("~/lib/session");
      localStorage.setItem("tg_apps_account_id", DEV_SIGN_IN_ACCOUNT_ID);
      localStorage.setItem("tg_apps_space_id", DEV_SIGN_IN_SPACE_ID);
      writeSession({
        subject: DEV_SIGN_IN_SUBJECT,
        sessionId: DEV_SIGN_IN_SESSION_ID,
        expiresAt: Date.now() + 1000 * 60 * 60 * 24,
        provider: "passkey",
        displayName: "Dev User",
        email: "dev@takosumi.test",
      });
      nav(safeReturnPath(params.return) ?? "/home");
    }
    : undefined;

  const runDevSignIn = () => {
    void devSignIn?.();
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
            disabled={!p.enabled}
            onClick={() => select(p.id)}
          >
            <span class="sign-in-icon">{p.icon()}</span>
            <span class="sign-in-text">
              <span class="sign-in-label">{p.label}</span>
              <span class="sign-in-sub-text">{p.sub}</span>
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
      {DEV_SIGN_IN_BUILD_ENABLED && (
        <Show when={showDevSignIn}>
          <button type="button" class="sign-in-dev" onClick={runDevSignIn}>
            Dev sign-in (local only)
          </button>
        </Show>
      )}
    </div>
  );
}

function safeReturnPath(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  return value;
}
