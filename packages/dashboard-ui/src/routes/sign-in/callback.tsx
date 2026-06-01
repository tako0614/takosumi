import { Title } from "@solidjs/meta";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { createSignal, onMount, Show } from "solid-js";
import { completeUpstreamOAuth, recallOAuthProvider } from "~/lib/api/oauth";
import { refreshSession } from "~/lib/session";

export default function SignInCallback() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    const code = params.code;
    const state = params.state;
    // Upstream providers don't pass `provider` back in the URL — recall it
    // from sessionStorage (stashed by startUpstreamOAuth) and fall back to
    // the URL only if the SPA initiated the flow via a deep link.
    const provider = (params.provider as "google" | "github" | undefined) ??
      recallOAuthProvider() ?? undefined;
    if (typeof code !== "string" || typeof state !== "string" || !provider) {
      setError(
        "OAuth response が不完全です (code / state / provider のいずれかが欠落)。 再度 sign-in を試してください。",
      );
      return;
    }
    completeUpstreamOAuth(code, state, provider)
      .then(async ({ returnTo }) => {
        // Populate the session cache from the just-set HttpOnly cookie
        // BEFORE we navigate. Without the await the next route's
        // AuthGuard runs before the /me roundtrip resolves and bounces
        // the user straight back to /sign-in.
        await refreshSession();
        nav(returnTo, { replace: true });
      })
      .catch((err: Error) => setError(err.message));
  });

  return (
    <>
      <Title>サインイン処理中... — Takosumi</Title>
      <div class="auth-page">
        <Show
          when={!error()}
          fallback={
            <div class="sign-in-panel">
              <h1 class="sign-in-title">サインインに失敗しました</h1>
              <p class="sign-in-error" role="alert">{error()}</p>
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
    </>
  );
}
