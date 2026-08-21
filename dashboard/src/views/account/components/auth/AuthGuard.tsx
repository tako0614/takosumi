import { useLocation, useNavigate } from "@solidjs/router";
import {
  createSignal,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import {
  onSessionStateChange,
  readSessionState,
  refreshSessionState,
  type SessionError,
  type SessionRecord,
  type SessionState,
} from "../../lib/session.ts";
import { t } from "../../../../i18n/index.ts";
import Button from "../../../../components/ui/Button.tsx";

interface Props {
  children: (session: SessionRecord) => JSX.Element;
  loadingFallback?: JSX.Element;
}

type AuthState = Exclude<SessionState["kind"], "loading"> | "loading";

/**
 * Wraps an account screen that requires a signed-in account-plane session.
 * While the session is being read on mount we render a small spinner (NOT
 * redirect, NOT render children) so the cookie roundtrip has a chance to
 * resolve. Only after the /api/v1/account/session/me probe resolves with `null`
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
  // The authenticated shell always mounts a Workspace switcher. Prime the
  // session and Workspace list through the same bootstrap request so the
  // first useful screen does not wait on two serial API roundtrips.
  const cached = readSessionState({ includeWorkspaces: true });
  const [session, setSession] = createSignal<SessionRecord | null>(
    cached.kind === "authenticated" ? cached.session : null,
  );
  const [state, setState] = createSignal<AuthState>(
    cached.kind === "authenticated" ? "authenticated" : cached.kind,
  );
  const [failure, setFailure] = createSignal<SessionError | null>(
    cached.kind === "maintenance" || cached.kind === "error"
      ? cached.error
      : null,
  );
  const nav = useNavigate();
  const loc = useLocation();

  const redirectToSignIn = (preserveReturn: boolean): void => {
    const target = preserveReturn
      ? "/sign-in?return=" + encodeURIComponent(loc.pathname + loc.search)
      : "/sign-in";
    nav(target, { replace: true });
  };

  const applyState = (
    next: SessionState,
    preserveReturn: boolean,
  ): void => {
    setFailure(
      next.kind === "maintenance" || next.kind === "error"
        ? next.error
        : null,
    );
    if (next.kind === "loading") {
      setSession(null);
      setState("loading");
      return;
    }
    if (next.kind === "authenticated") {
      setSession(next.session);
      setState("authenticated");
      return;
    }
    setSession(null);
    setState(next.kind);
    if (next.kind === "unauthenticated") {
      redirectToSignIn(preserveReturn);
    }
  };

  const retrySession = (): void => {
    applyState({ kind: "loading" }, false);
    void refreshSessionState({ includeWorkspaces: true }).then((next) =>
      applyState(next, true),
    );
  };

  onMount(() => {
    // With a cached session we already render the page; readSession() above has
    // already scheduled a quiet background refresh if it was stale, and
    // onSessionChange reacts if it changed. Only block on the probe when there
    // is no session yet (genuine first load / signed out).
    if (cached.kind !== "loading") {
      if (cached.kind === "unauthenticated") redirectToSignIn(true);
      return;
    }
    void refreshSessionState({ includeWorkspaces: true }).then((next) =>
      applyState(next, true),
    );
  });

  const off = onSessionStateChange((next) => {
    // Lost-session redirect: do NOT preserve the return path because this is
    // typically a sign-out, and bouncing the user back after sign-out is
    // surprising. Maintenance/errors never redirect.
    // The first probe applies its resolved state in the onMount promise below;
    // let that path own the initial unauthenticated redirect so it happens
    // once (and keeps the intended return path).
    if (next.kind === "unauthenticated" && state() === "loading") return;
    applyState(next, state() === "loading");
  });
  onCleanup(() => off());

  return (
    <Switch>
      <Match when={state() === "loading"}>
        {props.loadingFallback ?? (
          <div
            class="auth-loading"
            role="status"
            aria-label={t("common.loading")}
          >
            <span class="tg-spinner" aria-hidden="true" />
          </div>
        )}
      </Match>
      <Match when={state() === "maintenance" || state() === "error"}>
        <main class="auth-page">
          <div class="sign-in-panel notfound-panel">
            <h1 class="sign-in-title">
              {state() === "maintenance"
                ? t("auth.sessionMaintenanceTitle")
                : t("errorBoundary.title")}
            </h1>
            <p class="sign-in-sub">
              {state() === "maintenance"
                ? t("auth.sessionMaintenanceBody")
                : t("errorBoundary.body")}
            </p>
            <Button variant="primary" type="button" onClick={retrySession}>
              {t("common.retry")}
            </Button>
            <Show when={failure()?.status && failure()!.status > 0}>
              <span class="sr-only" aria-live="polite">
                {failure()!.status}
              </span>
            </Show>
          </div>
        </main>
      </Match>
      <Match when={state() === "authenticated" && session()}>
        {(s) => props.children(s())}
      </Match>
    </Switch>
  );
}
