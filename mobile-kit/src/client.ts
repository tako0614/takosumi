import type {
  FetchLike,
  HostDiscovery,
  MobileBiometricPrompt,
  MobileConnectPayload,
  MobileProductAdapter,
  MobileKnownHost,
  MobilePushNotification,
  MobilePushNotificationEventKind,
  MobilePushRegistration,
  MobileRoutePayload,
  MobileSession,
  MobileSessionUnlockOptions,
  NativeBridge,
} from "./types.ts";
import {
  beginMobileOidcSignIn,
  clearMobileSession,
  completeMobileOidcSignIn,
  ensureFreshMobileSession,
  isOidcCallbackPayload,
  loadMobileSession,
} from "./auth.ts";
import { discoverHost } from "./discovery.ts";
import { parseMobileConnectInput, parseMobileRouteInput } from "./handoff.ts";
import {
  loadMobileKnownHosts,
  rememberMobileKnownHost,
} from "./known-hosts.ts";
import {
  createFirstRunActions,
  createHostCenterHref,
  createMobileReturnUri,
  type FirstRunAction,
} from "./shell.ts";
import { normalizeHostUrl, openMobileHostRoute } from "./url.ts";

export interface MobileClientState<Home = unknown> {
  readonly connectInput: string;
  readonly connectPayload?: MobileConnectPayload;
  readonly knownHosts: readonly MobileKnownHost[];
  readonly status: string;
  readonly discovery?: HostDiscovery;
  readonly pendingRoute?: MobileRoutePayload;
  readonly session?: MobileSession;
  readonly lockedSession?: MobileSession;
  readonly unlockLoading: boolean;
  readonly home?: Home;
  readonly homeStatus: string;
  readonly homeLoading: boolean;
  readonly pushRegistration?: MobilePushRegistration;
  readonly lastPushNotification?: MobilePushNotification;
  readonly pushStatus: string;
  readonly pushLoading: boolean;
}

export interface MobileClientCopy {
  readonly initialStatus?: string;
  readonly checkingStatus?: string;
  readonly discoveredStatus?: string;
  readonly connectFirstStatus?: string;
  readonly preparingSignInStatus?: string;
  readonly openingSignInStatus?: string;
  readonly signedInStatus?: string;
  readonly signInFailedStatus?: string;
  readonly sessionRestoredStatus?: string;
  readonly sessionLockedStatus?: string;
  readonly sessionUnlockingStatus?: string;
  readonly sessionUnlockedStatus?: string;
  readonly sessionUnlockUnavailableStatus?: string;
  readonly sessionUnlockFailedStatus?: string;
  readonly unlockSessionLabel?: string;
  readonly signedOutStatus?: string;
  readonly qrFallbackStatus?: string;
  readonly urlFallbackStatus?: string;
  readonly homeLoadingStatus?: string;
  readonly homeReadyStatus?: string;
  readonly homeFailedStatus?: string;
  readonly pushRegisteringStatus?: string;
  readonly pushReadyStatus?: string;
  readonly pushUnavailableStatus?: string;
  readonly pushFailedStatus?: string;
  readonly pushTokenRefreshedStatus?: string;
  readonly pushNotificationReceivedStatus?: string;
  readonly pushNotificationTappedStatus?: string;
  readonly pushEventsFailedStatus?: string;
  readonly routePendingStatus?: string;
  readonly routeOpenedStatus?: string;
  readonly routeNeedsSessionStatus?: string;
  readonly routeFailedStatus?: string;
  readonly knownHostsLabel?: string;
}

export interface MobilePushRegistrationCallbackInput {
  readonly session: MobileSession;
  readonly registration: MobilePushRegistration;
}

export interface MobilePushNotificationCallbackInput {
  readonly session: MobileSession;
  readonly kind: MobilePushNotificationEventKind;
  readonly notification: MobilePushNotification;
}

export interface CreateMobileClientControllerOptions<Home = unknown> {
  readonly adapter: MobileProductAdapter;
  readonly nativeBridge: NativeBridge;
  readonly fetch?: FetchLike;
  readonly loadHome?: (session: MobileSession) => Promise<Home>;
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
  readonly copy?: MobileClientCopy;
  readonly homeLabel?: string;
}

export interface MobileClientActionResult {
  readonly focusInput?: boolean;
}

export interface MobileClientController<Home = unknown> {
  readonly actions: readonly FirstRunAction[];
  readonly getState: () => MobileClientState<Home>;
  readonly subscribe: (
    listener: (state: MobileClientState<Home>) => void,
  ) => () => void;
  readonly setConnectInput: (input: string) => void;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly handleLaunchPayload: (payload: string) => Promise<void>;
  readonly connect: () => Promise<void>;
  readonly connectWithInput: (input: string) => Promise<void>;
  readonly connectKnownHost: (hostUrl: string) => Promise<void>;
  readonly openHostCenter: () => Promise<void>;
  readonly startSignIn: () => Promise<MobileClientActionResult>;
  readonly completeSignIn: (callbackUrl: string) => Promise<void>;
  readonly unlockSession: () => Promise<void>;
  readonly refreshHome: (session?: MobileSession) => Promise<void>;
  readonly registerPushNotifications: (
    session?: MobileSession,
  ) => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly selectAction: (
    actionId: FirstRunAction["id"],
  ) => Promise<MobileClientActionResult>;
}

export function createMobileClientController<Home = unknown>(
  options: CreateMobileClientControllerOptions<Home>,
): MobileClientController<Home> {
  const actions = createFirstRunActions(options.adapter);
  const copy = createClientCopy(options);
  const listeners = new Set<(state: MobileClientState<Home>) => void>();
  let state: MobileClientState<Home> = {
    connectInput: "",
    knownHosts: [],
    status: copy.initialStatus,
    unlockLoading: false,
    homeStatus: "",
    homeLoading: false,
    pushStatus: "",
    pushLoading: false,
  };
  let launchPayloadUnlisten: (() => void) | undefined;
  let pushEventUnlisteners: Array<() => void | Promise<void>> = [];
  let started = false;

  function publish(next: Partial<MobileClientState<Home>>) {
    state = { ...state, ...next };
    const snapshot = controller.getState();
    for (const listener of listeners) listener(snapshot);
  }

  async function clearSessionAfterRefreshFailure(error: unknown) {
    await stopPushEventListeners();
    await clearMobileSession({
      adapter: options.adapter,
      nativeBridge: options.nativeBridge,
    });
    publish({
      session: undefined,
      lockedSession: undefined,
      unlockLoading: false,
      home: undefined,
      homeStatus: "",
      pushRegistration: undefined,
      lastPushNotification: undefined,
      pushStatus: "",
      pushLoading: false,
      status: error instanceof Error ? error.message : copy.signInFailedStatus,
    });
  }

  async function freshenSession(next: MobileSession): Promise<MobileSession> {
    try {
      return await ensureFreshMobileSession({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
        session: next,
        fetch: options.fetch,
      });
    } catch (error) {
      await clearSessionAfterRefreshFailure(error);
      throw error;
    }
  }

  async function activateSession(next: MobileSession, message: string) {
    let session: MobileSession;
    try {
      session = await freshenSession(next);
    } catch {
      return;
    }
    publish({
      session,
      knownHosts: await rememberKnownHost(session),
      lockedSession: undefined,
      unlockLoading: false,
      lastPushNotification: undefined,
      status: message,
    });
    await controller.refreshHome(session);
    await controller.registerPushNotifications(session);
    await startPushEventListeners(session);
    await openPendingRoute(session);
  }

  async function stopPushEventListeners() {
    const unlisteners = pushEventUnlisteners;
    pushEventUnlisteners = [];
    await stopRegisteredPushEventListeners(unlisteners);
  }

  async function stopRegisteredPushEventListeners(
    unlisteners: Array<() => void | Promise<void>>,
  ) {
    await Promise.allSettled(
      unlisteners.map(async (unlisten) => {
        await unlisten();
      }),
    );
  }

  async function startPushEventListeners(session: MobileSession) {
    await stopPushEventListeners();
    const nextUnlisteners: Array<() => void | Promise<void>> = [];
    const bridge = options.nativeBridge;
    try {
      if (bridge.onPushNotificationReceived) {
        nextUnlisteners.push(
          await bridge.onPushNotificationReceived((notification) => {
            void handlePushNotificationEvent(
              session,
              "received",
              notification,
            );
          }),
        );
      }
      if (bridge.onPushNotificationTapped) {
        nextUnlisteners.push(
          await bridge.onPushNotificationTapped((notification) => {
            void handlePushNotificationEvent(session, "tapped", notification);
          }),
        );
      }
      if (bridge.onPushTokenRefresh && options.registerPush) {
        nextUnlisteners.push(
          await bridge.onPushTokenRefresh(
            {
              hostUrl: session.hostUrl,
              product: session.product,
            },
            (registration) => {
              void handlePushTokenRefresh(session, registration);
            },
          ),
        );
      }
      pushEventUnlisteners = nextUnlisteners;
    } catch (error) {
      await stopRegisteredPushEventListeners(nextUnlisteners);
      publish({
        pushStatus:
          error instanceof Error ? error.message : copy.pushEventsFailedStatus,
      });
    }
  }

  function currentMatchingSession(session: MobileSession) {
    const current = state.session;
    if (
      !current ||
      current.hostUrl !== session.hostUrl ||
      current.product !== session.product
    ) {
      return undefined;
    }
    return current;
  }

  async function handlePushNotificationEvent(
    session: MobileSession,
    kind: MobilePushNotificationEventKind,
    notification: MobilePushNotification,
  ) {
    const current = currentMatchingSession(session);
    if (!current) return;
    publish({
      lastPushNotification: notification,
      pushStatus:
        kind === "tapped"
          ? copy.pushNotificationTappedStatus
          : copy.pushNotificationReceivedStatus,
    });
    try {
      await options.handlePushNotification?.({
        session: current,
        kind,
        notification,
      });
    } catch (error) {
      publish({
        pushStatus:
          error instanceof Error ? error.message : copy.pushEventsFailedStatus,
      });
    }
  }

  async function handlePushTokenRefresh(
    session: MobileSession,
    registration: MobilePushRegistration,
  ) {
    const current = currentMatchingSession(session);
    if (!current || !options.registerPush) return;
    publish({
      pushLoading: true,
      pushStatus: copy.pushRegisteringStatus,
    });
    try {
      await options.registerPush({ session: current, registration });
      publish({
        pushRegistration: registration,
        pushStatus: copy.pushTokenRefreshedStatus,
      });
    } catch (error) {
      publish({
        pushStatus:
          error instanceof Error ? error.message : copy.pushFailedStatus,
      });
    } finally {
      publish({ pushLoading: false });
    }
  }

  async function openPendingRoute(session: MobileSession) {
    const pendingRoute = state.pendingRoute;
    if (!pendingRoute || !routeMatchesSession(pendingRoute, session)) return;
    await openRoutePayload(pendingRoute);
  }

  async function openRoutePayload(route: MobileRoutePayload) {
    const current = state.session;
    if (current && routeMatchesSession(route, current)) {
      try {
        await openMobileHostRoute(options.nativeBridge, current, route.path);
        publish({
          pendingRoute: undefined,
          status: copy.routeOpenedStatus,
        });
      } catch (error) {
        publish({
          status:
            error instanceof Error ? error.message : copy.routeFailedStatus,
        });
      }
      return;
    }

    if (route.hostUrl) {
      publish({
        pendingRoute: route,
        connectInput: route.hostUrl,
        status: copy.routePendingStatus,
      });
      await connectToInput(route.hostUrl, true);
      publish({ status: copy.routePendingStatus });
      return;
    }

    publish({
      pendingRoute: route,
      status: copy.routeNeedsSessionStatus,
    });
  }

  function routeMatchesSession(
    route: MobileRoutePayload,
    session: MobileSession,
  ): boolean {
    if (!route.hostUrl) return true;
    return normalizeHostUrl(route.hostUrl) === normalizeHostUrl(session.hostUrl);
  }

  async function loadKnownHosts() {
    try {
      return await loadMobileKnownHosts({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
      });
    } catch {
      return [];
    }
  }

  async function rememberKnownHost(
    host: HostDiscovery | MobileSession | MobileKnownHost,
  ) {
    try {
      return await rememberMobileKnownHost({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
        host,
      });
    } catch {
      return state.knownHosts;
    }
  }

  async function connectToInput(input: string, preservePendingRoute = false) {
    publish({
      status: copy.checkingStatus,
      connectPayload: undefined,
      discovery: undefined,
      ...(preservePendingRoute ? {} : { pendingRoute: undefined }),
    });
    try {
      const payload = parseMobileConnectInput(input);
      const discovery = await discoverHost({
        hostUrl: payload.hostUrl,
        expectedProduct: options.adapter.product,
        fetch: options.fetch,
      });
      const knownHosts = await rememberKnownHost(discovery);
      publish({
        connectPayload: payload,
        discovery,
        knownHosts,
        status: payload.setupTicket
          ? `${copy.discoveredStatus} Host Center handoff received.`
          : copy.discoveredStatus,
      });
    } catch (error) {
      publish({
        connectPayload: undefined,
        status:
          error instanceof Error ? error.message : "Host connection failed.",
      });
    }
  }

  const controller: MobileClientController<Home> = {
    actions,
    getState() {
      return { ...state };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(controller.getState());
      return () => {
        listeners.delete(listener);
      };
    },
    setConnectInput(input) {
      publish({ connectInput: input });
    },
    async start() {
      if (started) return;
      started = true;
      if (options.nativeBridge.onLaunchPayload) {
        launchPayloadUnlisten = await options.nativeBridge.onLaunchPayload(
          (payload) => {
            void controller.handleLaunchPayload(payload);
          },
        );
      }

      publish({ knownHosts: await loadKnownHosts() });

      const existingSession = await loadMobileSession({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
      });
      if (existingSession) {
        if (shouldLockRestoredSession(options, existingSession)) {
          publish({
            lockedSession: existingSession,
            status: copy.sessionLockedStatus,
          });
        } else {
          await activateSession(existingSession, copy.sessionRestoredStatus);
        }
      }

      const payload = await options.nativeBridge.getLaunchPayload();
      if (payload) await controller.handleLaunchPayload(payload);
    },
    stop() {
      launchPayloadUnlisten?.();
      launchPayloadUnlisten = undefined;
      void stopPushEventListeners();
      started = false;
    },
    async handleLaunchPayload(payload) {
      if (isOidcCallbackPayload(payload)) {
        await controller.completeSignIn(payload);
        return;
      }
      try {
        const route = parseMobileRouteInput(payload, options.adapter);
        if (route) {
          await openRoutePayload(route);
          return;
        }
      } catch (error) {
        publish({
          status:
            error instanceof Error ? error.message : copy.routeFailedStatus,
        });
        return;
      }
      controller.setConnectInput(payload);
      await controller.connectWithInput(payload);
    },
    async connect() {
      await controller.connectWithInput(state.connectInput);
    },
    async connectWithInput(input) {
      await connectToInput(input);
    },
    async connectKnownHost(hostUrl) {
      controller.setConnectInput(hostUrl);
      await connectToInput(hostUrl);
    },
    async openHostCenter() {
      await options.nativeBridge.openExternalUrl(
        createHostCenterHref({
          adapter: options.adapter,
          returnUri: createMobileReturnUri(options.adapter),
        }),
      );
    },
    async startSignIn() {
      const current = state.discovery;
      if (!current) {
        publish({ status: copy.connectFirstStatus });
        return { focusInput: true };
      }
      publish({ status: copy.preparingSignInStatus });
      try {
        const result = await beginMobileOidcSignIn({
          adapter: options.adapter,
          discovery: current,
          nativeBridge: options.nativeBridge,
          fetch: options.fetch,
        });
        publish({ status: copy.openingSignInStatus });
        await options.nativeBridge.openExternalUrl(result.authorizationUrl);
      } catch (error) {
        publish({
          status:
            error instanceof Error ? error.message : copy.signInFailedStatus,
        });
      }
      return {};
    },
    async completeSignIn(callbackUrl) {
      publish({ status: "Completing sign-in..." });
      try {
        const session = await completeMobileOidcSignIn({
          adapter: options.adapter,
          nativeBridge: options.nativeBridge,
          callbackUrl,
          fetch: options.fetch,
        });
        await activateSession(session, copy.signedInStatus);
      } catch (error) {
        publish({
          status:
            error instanceof Error ? error.message : copy.signInFailedStatus,
        });
      }
    },
    async unlockSession() {
      const current = state.lockedSession;
      if (!current) return;
      const unlocker = options.nativeBridge.authenticateBiometric;
      if (
        !options.nativeBridge.capabilities.biometricAuth ||
        !unlocker
      ) {
        if (sessionUnlockMode(options) === "required") {
          publish({ status: copy.sessionUnlockUnavailableStatus });
          return;
        }
        publish({ lockedSession: undefined });
        await activateSession(current, copy.sessionRestoredStatus);
        return;
      }
      publish({
        unlockLoading: true,
        status: copy.sessionUnlockingStatus,
      });
      try {
        const authenticated = await unlocker(
          resolveSessionUnlockPrompt(options.sessionUnlock, current),
        );
        if (!authenticated) {
          publish({ status: copy.sessionUnlockFailedStatus });
          return;
        }
        publish({ lockedSession: undefined });
        await activateSession(current, copy.sessionUnlockedStatus);
      } catch (error) {
        publish({
          status:
            error instanceof Error
              ? error.message
              : copy.sessionUnlockFailedStatus,
        });
      } finally {
        publish({ unlockLoading: false });
      }
    },
    async refreshHome(current = state.session) {
      if (!current || !options.loadHome) return;
      publish({ homeLoading: true, homeStatus: copy.homeLoadingStatus });
      try {
        const session = await freshenSession(current);
        if (session !== current) publish({ session });
        publish({
          home: await options.loadHome(session),
          homeStatus: copy.homeReadyStatus,
        });
      } catch (error) {
        publish({
          home: undefined,
          homeStatus:
            error instanceof Error ? error.message : copy.homeFailedStatus,
        });
      } finally {
        publish({ homeLoading: false });
      }
    },
    async registerPushNotifications(current = state.session) {
      if (!current || !options.registerPush) return;
      if (!options.nativeBridge.registerPushNotifications) {
        publish({ pushStatus: copy.pushUnavailableStatus });
        return;
      }
      publish({ pushLoading: true, pushStatus: copy.pushRegisteringStatus });
      try {
        const registration =
          await options.nativeBridge.registerPushNotifications({
            hostUrl: current.hostUrl,
            product: current.product,
          });
        if (!registration) {
          publish({ pushStatus: copy.pushUnavailableStatus });
          return;
        }
        await options.registerPush({ session: current, registration });
        publish({
          pushRegistration: registration,
          pushStatus: copy.pushReadyStatus,
        });
      } catch (error) {
        publish({
          pushRegistration: undefined,
          pushStatus:
            error instanceof Error ? error.message : copy.pushFailedStatus,
        });
      } finally {
        publish({ pushLoading: false });
      }
    },
    async signOut() {
      await stopPushEventListeners();
      const currentSession = state.session;
      const currentPushRegistration = state.pushRegistration;
      if (currentSession && currentPushRegistration && options.unregisterPush) {
        try {
          await options.unregisterPush({
            session: currentSession,
            registration: currentPushRegistration,
          });
        } catch {
          // Sign-out must remain local-first; stale push registrations can be
          // overwritten by the next sign-in or cleaned by host retention.
        }
      }
      await clearMobileSession({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
      });
      publish({
        connectPayload: undefined,
        discovery: undefined,
        pendingRoute: undefined,
        session: undefined,
        lockedSession: undefined,
        unlockLoading: false,
        home: undefined,
        homeStatus: "",
        pushRegistration: undefined,
        lastPushNotification: undefined,
        pushStatus: "",
        pushLoading: false,
        status: copy.signedOutStatus,
      });
    },
    async selectAction(actionId) {
      if (actionId === "host") {
        await controller.openHostCenter();
        return {};
      }
      if (actionId === "qr" && options.nativeBridge.scanConnectionPayload) {
        const payload = await options.nativeBridge.scanConnectionPayload();
        if (payload) {
          controller.setConnectInput(payload);
          await controller.connectWithInput(payload);
          return {};
        }
      }
      publish({
        status:
          actionId === "qr" ? copy.qrFallbackStatus : copy.urlFallbackStatus,
      });
      return { focusInput: true };
    },
  };

  return controller;
}

function createClientCopy(
  options: CreateMobileClientControllerOptions,
): Required<MobileClientCopy> {
  const hostNoun = options.adapter.hostNoun;
  const homeLabel =
    options.homeLabel ??
    (options.adapter.product === "takos" ? "workspace" : "instance");
  return {
    initialStatus:
      options.copy?.initialStatus ??
      `Enter a ${hostNoun} URL or connection payload.`,
    checkingStatus: options.copy?.checkingStatus ?? `Checking ${hostNoun}...`,
    discoveredStatus: options.copy?.discoveredStatus ?? `${hostNoun} found.`,
    connectFirstStatus:
      options.copy?.connectFirstStatus ?? `Connect to a ${hostNoun} first.`,
    preparingSignInStatus:
      options.copy?.preparingSignInStatus ?? "Preparing sign-in...",
    openingSignInStatus:
      options.copy?.openingSignInStatus ?? "Opening sign-in...",
    signedInStatus: options.copy?.signedInStatus ?? "Signed in.",
    signInFailedStatus: options.copy?.signInFailedStatus ?? "Sign-in failed.",
    sessionRestoredStatus:
      options.copy?.sessionRestoredStatus ?? "Session restored.",
    sessionLockedStatus:
      options.copy?.sessionLockedStatus ??
      "Saved session is locked. Unlock to continue.",
    sessionUnlockingStatus:
      options.copy?.sessionUnlockingStatus ?? "Unlocking session...",
    sessionUnlockedStatus:
      options.copy?.sessionUnlockedStatus ?? "Session unlocked.",
    sessionUnlockUnavailableStatus:
      options.copy?.sessionUnlockUnavailableStatus ??
      "Session unlock is not available on this device.",
    sessionUnlockFailedStatus:
      options.copy?.sessionUnlockFailedStatus ??
      "Session unlock was canceled.",
    unlockSessionLabel:
      options.copy?.unlockSessionLabel ?? "Unlock session",
    signedOutStatus: options.copy?.signedOutStatus ?? "Signed out.",
    qrFallbackStatus:
      options.copy?.qrFallbackStatus ??
      "Paste the connection payload from your QR code.",
    urlFallbackStatus:
      options.copy?.urlFallbackStatus ?? `Enter the ${hostNoun} URL.`,
    homeLoadingStatus:
      options.copy?.homeLoadingStatus ?? `Loading ${homeLabel}...`,
    homeReadyStatus:
      options.copy?.homeReadyStatus ?? `${capitalize(homeLabel)} ready.`,
    homeFailedStatus:
      options.copy?.homeFailedStatus ?? `${capitalize(homeLabel)} load failed.`,
    pushRegisteringStatus:
      options.copy?.pushRegisteringStatus ??
      "Registering push notifications...",
    pushReadyStatus:
      options.copy?.pushReadyStatus ?? "Push notifications ready.",
    pushUnavailableStatus:
      options.copy?.pushUnavailableStatus ??
      "Push notifications are not available on this device.",
    pushFailedStatus:
      options.copy?.pushFailedStatus ??
      "Push notification registration failed.",
    pushTokenRefreshedStatus:
      options.copy?.pushTokenRefreshedStatus ??
      "Push notification token refreshed.",
    pushNotificationReceivedStatus:
      options.copy?.pushNotificationReceivedStatus ??
      "Push notification received.",
    pushNotificationTappedStatus:
      options.copy?.pushNotificationTappedStatus ??
      "Push notification opened.",
    pushEventsFailedStatus:
      options.copy?.pushEventsFailedStatus ??
      "Push notification events are unavailable.",
    routePendingStatus:
      options.copy?.routePendingStatus ??
      "Sign in to open the requested route.",
    routeOpenedStatus:
      options.copy?.routeOpenedStatus ?? "Opened requested route.",
    routeNeedsSessionStatus:
      options.copy?.routeNeedsSessionStatus ??
      "Sign in before opening this mobile route.",
    routeFailedStatus:
      options.copy?.routeFailedStatus ?? "Mobile route open failed.",
    knownHostsLabel: options.copy?.knownHostsLabel ?? "Recent hosts",
  };
}

function shouldLockRestoredSession(
  options: CreateMobileClientControllerOptions,
  session: MobileSession,
): boolean {
  const mode = sessionUnlockMode(options);
  if (mode === "off") return false;
  if (
    mode === "if-available" &&
    (!options.nativeBridge.capabilities.biometricAuth ||
      !options.nativeBridge.authenticateBiometric)
  ) {
    return false;
  }
  return Boolean(session.accessToken);
}

function sessionUnlockMode(
  options: CreateMobileClientControllerOptions,
): "off" | "if-available" | "required" {
  return options.sessionUnlock?.restoreMode ?? "off";
}

function resolveSessionUnlockPrompt(
  unlock: MobileSessionUnlockOptions | undefined,
  session: MobileSession,
): MobileBiometricPrompt {
  const prompt =
    typeof unlock?.prompt === "function"
      ? unlock.prompt(session)
      : unlock?.prompt;
  return (
    prompt ?? {
      message: `Unlock ${session.product} mobile session`,
      allowDeviceCredential: true,
    }
  );
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
