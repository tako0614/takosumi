import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import {
  createMobileClientController,
  type MobilePushNotificationCallbackInput,
  type MobilePushRegistrationCallbackInput,
  type MobileClientState,
} from "./client.ts";
import { resolvePushNotificationPath } from "./push-navigation.ts";
import type {
  MobileKnownHost,
  MobileProductAdapter,
  MobileSession,
  MobileSessionUnlockOptions,
  NativeBridge,
} from "./types.ts";
import { createMobileHostRouteUrl, openMobileHostRoute } from "./url.ts";
import { mobileErrorMessage } from "./error.ts";
import { copyMobileText } from "./shell.ts";
import type {
  MobileShellHostAction,
  MobileShellHostActionContext,
} from "./host-actions.ts";
export {
  defineMobileHostActions,
  type MobileShellHostAction,
  type MobileShellHostActionContext,
  type MobileShellNativeIntent,
} from "./host-actions.ts";

export interface MobileShellMetric<Home> {
  readonly label: string;
  readonly value: (home: Home | undefined) => number | undefined;
}

export interface MobileShellHomeExtraContext<Home> {
  readonly home: Home | undefined;
  readonly session: MobileSession;
  readonly refreshHome: () => Promise<void>;
  readonly openHostRoute: (path: string) => Promise<void>;
  readonly openExternalUrl: (url: string) => Promise<void>;
  readonly writeClipboardText?: NativeBridge["writeClipboardText"];
}

export interface MobileShellCopy<Home> {
  readonly eyebrow?: string;
  readonly summary: string;
  readonly connectLabel: string;
  readonly knownHostsLabel?: string;
  readonly knownHostsClearLabel?: string;
  readonly knownHostForgetLabel?: (host: MobileKnownHost) => string;
  readonly discoveredHeading: string;
  readonly homeFallbackTitle: string;
  readonly lockedSessionTitle?: string;
  readonly unlockSessionLabel?: string;
  readonly refreshLabel: string;
  readonly copyHostUrlLabel?: string;
  readonly copyHostUrlSuccessStatus?: string;
  readonly copyHostUrlFailedStatus?: string;
  readonly homeTitle: (home: Home | undefined) => string | undefined;
  readonly metricsLabel: string;
  readonly shortcutsLabel: string;
}

export interface MobileClientShellProps<Home> {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly loadHome: (session: MobileSession) => Promise<Home>;
  readonly registerPush?: (
    input: MobilePushRegistrationCallbackInput,
  ) => Promise<void>;
  readonly unregisterPush?: (
    input: MobilePushRegistrationCallbackInput,
  ) => Promise<void>;
  readonly handlePushNotification?: (
    input: MobilePushNotificationCallbackInput,
  ) => Promise<void> | void;
  readonly sessionUnlock?: MobileSessionUnlockOptions;
  readonly homeLabel: string;
  readonly copy: MobileShellCopy<Home>;
  readonly metrics: readonly MobileShellMetric<Home>[];
  readonly hostActions: readonly MobileShellHostAction<Home>[];
  readonly renderHomeExtra?: (
    context: MobileShellHomeExtraContext<Home>,
  ) => JSX.Element;
}

export function MobileClientShell<Home>(props: MobileClientShellProps<Home>) {
  const controller = createMobileClientController<Home>({
    adapter: props.adapter,
    nativeBridge: props.nativeBridge,
    loadHome: props.loadHome,
    registerPush: props.registerPush,
    unregisterPush: props.unregisterPush,
    handlePushNotification: async (input) => {
      await props.handlePushNotification?.(input);
      if (input.kind !== "tapped") return;
      const routePath = resolvePushNotificationPath(input);
      if (routePath) {
        await openMobileHostRoute(props.nativeBridge, input.session, routePath);
      }
    },
    sessionUnlock: props.sessionUnlock,
    homeLabel: props.homeLabel,
  });
  const [state, setState] = createSignal<MobileClientState<Home>>(
    controller.getState(),
  );
  const [hostCopyStatus, setHostCopyStatus] = createSignal<
    string | undefined
  >();
  let inputRef: HTMLInputElement | undefined;
  let unsubscribe: (() => void) | undefined;

  onMount(() => {
    unsubscribe = controller.subscribe(setState);
    void controller.start();
  });

  onCleanup(() => {
    unsubscribe?.();
    controller.stop();
  });

  async function selectAction(
    actionId: (typeof controller.actions)[number]["id"],
  ) {
    const result = await controller.selectAction(actionId);
    if (result.focusInput) inputRef?.focus();
  }

  async function startSignIn() {
    const result = await controller.startSignIn();
    if (result.focusInput) inputRef?.focus();
  }

  async function connectKnownHost(hostUrl: string) {
    await controller.connectKnownHost(hostUrl);
  }

  async function forgetKnownHost(hostUrl: string) {
    await controller.forgetKnownHost(hostUrl);
  }

  async function clearKnownHosts() {
    await controller.clearKnownHosts();
  }

  async function openHostAction(
    session: MobileSession,
    action: MobileShellHostAction<Home>,
  ) {
    const routePath = resolveHostActionPath(action, {
      session,
      home: state().home,
    });
    if (!routePath) return;
    if (action.nativeIntent === "call" && props.nativeBridge.requestCall) {
      await props.nativeBridge.requestCall({
        roomUrl: createMobileHostRouteUrl(session, routePath),
        title: action.label,
      });
      return;
    }
    await openMobileHostRoute(props.nativeBridge, session, routePath);
  }

  async function copyHostUrl(session: MobileSession) {
    try {
      await copyMobileText({
        text: session.hostUrl,
        label: `${props.adapter.appName} host URL`,
        writeClipboardText: props.nativeBridge.writeClipboardText,
      });
      setHostCopyStatus(
        props.copy.copyHostUrlSuccessStatus ?? "Host URL copied.",
      );
    } catch (error) {
      setHostCopyStatus(
        mobileErrorMessage(
          error,
          props.copy.copyHostUrlFailedStatus ?? "Host URL copy failed.",
        ),
      );
    }
  }

  const homeTitle = () =>
    props.copy.homeTitle(state().home) ?? props.copy.homeFallbackTitle;

  return (
    <main class="app-shell" style={{ "--accent": props.adapter.accentColor }}>
      <section class="masthead">
        <p class="eyebrow">{props.copy.eyebrow ?? "Mobile client"}</p>
        <h1>{props.adapter.appName}</h1>
        <p class="summary">{props.copy.summary}</p>
      </section>

      <section class="actions" aria-label="Connection options">
        <For each={controller.actions}>
          {(action) => (
            <button
              type="button"
              class="action-button"
              onClick={() => void selectAction(action.id)}
            >
              <span>{action.label}</span>
              <small>{action.description}</small>
            </button>
          )}
        </For>
      </section>

      <form
        class="connect-panel"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.connect();
        }}
      >
        <label for="connect-input">{props.copy.connectLabel}</label>
        <input
          id="connect-input"
          name="mobile-connect"
          ref={inputRef}
          inputMode="url"
          value={state().connectInput}
          placeholder={props.adapter.urlPlaceholder}
          onInput={(event) =>
            controller.setConnectInput(event.currentTarget.value)
          }
        />
        <button type="submit" class="primary">
          {props.adapter.primaryActionLabel}
        </button>
        <p class="status">{state().status}</p>
      </form>

      <Show when={!state().session && state().knownHosts.length > 0}>
        <section
          class="known-hosts"
          aria-label={props.copy.knownHostsLabel ?? "Recent hosts"}
        >
          <div class="known-hosts-header">
            <h2>{props.copy.knownHostsLabel ?? "Recent hosts"}</h2>
            <button
              type="button"
              class="text-button"
              onClick={() => void clearKnownHosts()}
            >
              {props.copy.knownHostsClearLabel ?? "Clear"}
            </button>
          </div>
          <div class="known-host-list">
            <For each={state().knownHosts}>
              {(host) => (
                <div class="known-host-row">
                  <button
                    type="button"
                    class="known-host"
                    onClick={() => void connectKnownHost(host.hostUrl)}
                  >
                    <span>{host.label ?? host.hostUrl}</span>
                    <small>{formatKnownHostDate(host.lastSeenAt)}</small>
                  </button>
                  <button
                    type="button"
                    class="known-host-remove"
                    aria-label={
                      props.copy.knownHostForgetLabel?.(host) ??
                      `Remove ${host.label ?? host.hostUrl}`
                    }
                    onClick={() => void forgetKnownHost(host.hostUrl)}
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show when={state().discovery}>
        {(current) => (
          <section class="result-panel">
            <h2>{props.copy.discoveredHeading}</h2>
            <dl>
              <div>
                <dt>Host</dt>
                <dd>{current().hostUrl}</dd>
              </div>
              <div>
                <dt>Product</dt>
                <dd>{current().detectedProduct ?? props.adapter.product}</dd>
              </div>
              <Show when={state().connectPayload?.setupTicket}>
                <div>
                  <dt>Host Center handoff</dt>
                  <dd>
                    <span class="handoff-pill">Setup ticket received</span>
                  </dd>
                </div>
              </Show>
              <div>
                <dt>OIDC issuer</dt>
                <dd>{current().oidcIssuer}</dd>
              </div>
            </dl>
            <button type="button" class="primary" onClick={startSignIn}>
              Sign in
            </button>
          </section>
        )}
      </Show>

      <Show when={state().session ? undefined : state().lockedSession}>
        {(lockedSession) => (
          <section class="result-panel">
            <div class="panel-header">
              <div>
                <h2>{props.copy.lockedSessionTitle ?? "Session locked"}</h2>
                <p>{lockedSession().hostUrl}</p>
              </div>
              <button
                type="button"
                class="primary"
                disabled={state().unlockLoading}
                onClick={() => void controller.unlockSession()}
              >
                {props.copy.unlockSessionLabel ?? "Unlock"}
              </button>
            </div>
            <p class="status">{state().status}</p>
          </section>
        )}
      </Show>

      <Show when={state().session}>
        {(current) => (
          <section class="result-panel">
            <div class="panel-header">
              <div>
                <h2>{homeTitle()}</h2>
                <p>{current().hostUrl}</p>
              </div>
              <div class="panel-actions">
                <Show when={props.nativeBridge.writeClipboardText}>
                  <button
                    type="button"
                    class="icon-button"
                    aria-label={props.copy.copyHostUrlLabel ?? "Copy URL"}
                    onClick={() => void copyHostUrl(current())}
                  >
                    {props.copy.copyHostUrlLabel ?? "Copy URL"}
                  </button>
                </Show>
                <button
                  type="button"
                  class="icon-button"
                  aria-label={props.copy.refreshLabel}
                  disabled={state().homeLoading}
                  onClick={() => void controller.refreshHome()}
                >
                  Refresh
                </button>
              </div>
            </div>
            <div class="metrics" aria-label={props.copy.metricsLabel}>
              <For each={props.metrics}>
                {(metric) => (
                  <div>
                    <span>{formatCount(metric.value(state().home))}</span>
                    <small>{metric.label}</small>
                  </div>
                )}
              </For>
            </div>
            <div class="quick-actions" aria-label={props.copy.shortcutsLabel}>
              <For each={props.hostActions}>
                {(action) => (
                  <button
                    type="button"
                    class="quick-action"
                    onClick={() => void openHostAction(current(), action)}
                  >
                    <span>{action.label}</span>
                    <small>{action.description}</small>
                  </button>
                )}
              </For>
            </div>
            {props.renderHomeExtra?.({
              home: state().home,
              session: current(),
              refreshHome: () => controller.refreshHome(current()),
              openHostRoute: (path) =>
                openMobileHostRoute(props.nativeBridge, current(), path),
              openExternalUrl: (url) => props.nativeBridge.openExternalUrl(url),
              writeClipboardText: props.nativeBridge.writeClipboardText,
            })}
            <dl>
              <div>
                <dt>Token type</dt>
                <dd>{current().tokenType}</dd>
              </div>
              <Show when={current().expiresAt}>
                {(expiresAt) => (
                  <div>
                    <dt>Expires</dt>
                    <dd>{expiresAt()}</dd>
                  </div>
                )}
              </Show>
            </dl>
            <p class="status">{state().homeStatus}</p>
            <Show when={hostCopyStatus()}>
              {(copyStatus) => <p class="status">{copyStatus()}</p>}
            </Show>
            <Show when={state().pushStatus}>
              {(pushStatus) => <p class="status">{pushStatus()}</p>}
            </Show>
            <button
              type="button"
              class="secondary"
              onClick={() => void controller.signOut()}
            >
              Sign out
            </button>
          </section>
        )}
      </Show>
    </main>
  );
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" ? String(value) : "-";
}

function formatKnownHostDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Recent";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function resolveHostActionPath<Home>(
  action: MobileShellHostAction<Home>,
  context: MobileShellHostActionContext<Home>,
): string | undefined {
  return typeof action.path === "function" ? action.path(context) : action.path;
}
