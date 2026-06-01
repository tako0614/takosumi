import { useNavigate } from "@solidjs/router";
import { onMount } from "solid-js";
import { refreshSession } from "~/lib/session";

/**
 * accounts.takosumi.com / has no marketing landing — marketing lives at
 * takosumi.com. Visitors are sent straight to sign-in (or /home if a
 * session is already valid). We probe the server-side session via
 * /v1/account/session/me because the cookie is HttpOnly and cannot
 * be checked from JS-only state.
 */
export default function Index() {
  const nav = useNavigate();

  onMount(() => {
    void refreshSession().then((session) => {
      nav(session ? "/home" : "/sign-in", { replace: true });
    });
  });

  return (
    <div class="auth-page">
      <p class="auth-spinner">読み込み中...</p>
    </div>
  );
}
