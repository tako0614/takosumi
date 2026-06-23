import { useLocation, useNavigate } from "@solidjs/router";
import {
  createSignal,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Switch,
} from "solid-js";
import {
  onSessionChange,
  readSession,
  refreshSession,
  type SessionRecord,
} from "../../lib/session.ts";
import { t } from "../../../../i18n/index.ts";

interface Props {
  children: (session: SessionRecord) => JSX.Element;
}

type AuthState = "loading" | "authenticated" | "unauthenticated";

/**
 * Wraps an account screen that requires a signed-in account-plane session.
 * While the session is being read on mount we render a small spinner (NOT
 * redirect, NOT render children) so the cookie roundtrip has a chance to
 * resolve. Only after the /v1/account/session/me probe resolves with `null`
 * do we redirect to /sign-in with the intended return path preserved in
 * `?return=`.
 *
 * Ported from takosumi dashboard-ui/src/components/auth/AuthGuard.tsx. Gates
 * on the account-plane cookie session, which is distinct from the takos
 * product `useAuth()` session.
 */
export default function AuthGuard(props: Props) {
  // Cache-first: the session is held module-side and survives navigation, so a
  // page change that already has a known session renders instantly instead of
  // re-probing /session/me and flashing a full-screen spinner every time.
  const cached = readSession();
  const [session, setSession] = createSignal<SessionRecord | null>(cached);
  const [state, setState] = createSignal<AuthState>(
    cached ? "authenticated" : "loading",
  );
  const nav = useNavigate();
  const loc = useLocation();

  const redirectToSignIn = (preserveReturn: boolean): void => {
    const target = preserveReturn
      ? "/sign-in?return=" + encodeURIComponent(loc.pathname + loc.search)
      : "/sign-in";
    nav(target, { replace: true });
  };

  onMount(() => {
    // With a cached session we already render the page; readSession() above has
    // already scheduled a quiet background refresh if it was stale, and
    // onSessionChange reacts if it changed. Only block on the probe when there
    // is no session yet (genuine first load / signed out).
    if (session()) return;
    void refreshSession().then((s) => {
      setSession(s);
      if (s) {
        setState("authenticated");
        return;
      }
      setState("unauthenticated");
      redirectToSignIn(true);
    });
  });

  const off = onSessionChange((s) => {
    setSession(s);
    if (!s && state() !== "loading") {
      setState("unauthenticated");
      // Lost-session redirect: do NOT preserve the return path because
      // this is typically a sign-out, and bouncing the user back to
      // the gated page after sign-out is surprising.
      redirectToSignIn(false);
    } else if (s) {
      setState("authenticated");
    }
  });
  onCleanup(() => off());

  return (
    <Switch>
      <Match when={state() === "loading"}>
        <div
          class="auth-loading"
          role="status"
          aria-label={t("common.loading")}
        >
          <span class="tg-spinner" aria-hidden="true" />
        </div>
      </Match>
      <Match when={state() === "authenticated" && session()}>
        {(s) => props.children(s())}
      </Match>
    </Switch>
  );
}
