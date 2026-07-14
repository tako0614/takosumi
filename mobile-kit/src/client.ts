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
  persistMobileSession,
} from "./auth.ts";
import { discoverHost } from "./discovery.ts";
import { parseMobileConnectInput, parseMobileRouteInput } from "./handoff.ts";
import {
  clearMobileKnownHosts,
  loadMobileKnownHosts,
  rememberMobileKnownHost,
  removeMobileKnownHost,
} from "./known-hosts.ts";
import {
  createFirstRunActions,
  createHostCenterHref,
  createMobileReturnUri,
  type FirstRunAction,
} from "./shell.ts";
import { mobileErrorMessage } from "./error.ts";
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
  readonly knownHostRemovedStatus?: string;
  readonly knownHostsClearedStatus?: string;
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
  /** Overrides adapter.oidcScopes for this controller instance. */
  readonly oidcScopes?: readonly string[];
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
  readonly forgetKnownHost: (hostUrl: string) => Promise<void>;
  readonly clearKnownHosts: () => Promise<void>;
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
  const signOutCleanupTimeoutMs = 5_000;
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
  let sessionLifecycleEpoch = 0;
  let sessionStorageQueue: Promise<void> = Promise.resolve();
  let pushOperationQueue: Promise<void> = Promise.resolve();
  let started = false;

  function publish(next: Partial<MobileClientState<Home>>) {
    state = { ...state, ...next };
    const snapshot = controller.getState();
    for (const listener of listeners) listener(snapshot);
  }

  async function clearSessionAfterRefreshFailure(
    error: unknown,
    expectedEpoch: number,
  ) {
    if (expectedEpoch !== sessionLifecycleEpoch) return;
    invalidateSessionLifecycle();
    await stopPushEventListeners();
    await enqueueSessionStorageOperation(async () => {
      await clearMobileSession({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
      });
    });
    publish({
      session: undefined,
      lockedSession: undefined,
      unlockLoading: false,
      home: undefined,
      homeStatus: "",
      homeLoading: false,
      pushRegistration: undefined,
      lastPushNotification: undefined,
      pushStatus: "",
      pushLoading: false,
      status: mobileErrorMessage(error, copy.signInFailedStatus),
    });
  }

  async function freshenSession(
    next: MobileSession,
    expectedEpoch: number,
  ): Promise<MobileSession> {
    try {
      const session = await ensureFreshMobileSession({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
        session: next,
        persistSession: false,
        fetch: options.fetch,
      });
      if (
        session !== next &&
        !(await persistSessionForEpoch(session, expectedEpoch))
      ) {
        return session;
      }
      return session;
    } catch (error) {
      await clearSessionAfterRefreshFailure(error, expectedEpoch);
      throw error;
    }
  }

  async function activateSession(
    next: MobileSession,
    message: string,
    expectedEpoch = sessionLifecycleEpoch,
  ) {
    if (expectedEpoch !== sessionLifecycleEpoch) return;
    const previousSession = state.session;
    const previousPushRegistration = state.pushRegistration;
    const replacedSession = Boolean(previousSession);
    const epoch = invalidateSessionLifecycle();
    await stopPushEventListeners();
    if (epoch !== sessionLifecycleEpoch) return;

    let session: MobileSession;
    try {
      session = await freshenSession(next, epoch);
    } catch {
      return;
    }
    if (epoch !== sessionLifecycleEpoch) return;
    if (previousSession && previousPushRegistration) {
      await unregisterPushBestEffort(previousSession, previousPushRegistration);
      if (epoch !== sessionLifecycleEpoch) return;
    }
    publish({
      session,
      knownHosts: await rememberKnownHost(session),
      lockedSession: undefined,
      unlockLoading: false,
      lastPushNotification: undefined,
      ...(replacedSession
        ? { pushRegistration: undefined, pushStatus: "" }
        : {}),
      status: message,
    });
    await refreshHomeForSession(session, epoch);
    if (!currentMatchingSession(session, epoch)) return;
    await controller.registerPushNotifications(session);
    if (!currentMatchingSession(session, epoch)) return;
    await startPushEventListeners(session, epoch);
    if (!currentMatchingSession(session, epoch)) return;
    await openPendingRoute(session);
  }

  function invalidateSessionLifecycle(): number {
    sessionLifecycleEpoch += 1;
    return sessionLifecycleEpoch;
  }

  function enqueuePushOperation(operation: () => Promise<void>): Promise<void> {
    const queued = pushOperationQueue.then(operation, operation);
    pushOperationQueue = queued.catch(() => undefined);
    return queued;
  }

  function enqueueSessionStorageOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const queued = sessionStorageQueue.then(operation, operation);
    sessionStorageQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function persistSessionForEpoch(
    session: MobileSession,
    expectedEpoch: number,
  ): Promise<boolean> {
    return await enqueueSessionStorageOperation(async () => {
      if (expectedEpoch !== sessionLifecycleEpoch) return false;
      await persistMobileSession({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
        session,
      });
      if (expectedEpoch === sessionLifecycleEpoch) return true;
      await clearMobileSession({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
      });
      return false;
    });
  }

  async function unregisterPushBestEffort(
    session: MobileSession,
    registration: MobilePushRegistration,
  ) {
    if (!options.unregisterPush) return;
    try {
      await options.unregisterPush({ session, registration });
    } catch {
      // A failed cleanup must not restore or roll back a newer lifecycle.
      // Provider rejection and host retention remain the final backstop.
    }
  }

  async function unregisterNativePushBestEffort() {
    try {
      await options.nativeBridge.unregisterPushNotifications?.();
    } catch {
      // Provider cleanup is best effort. A later registration obtains the
      // current provider identity and host retention bounds stale rows.
    }
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

  async function startPushEventListeners(
    session: MobileSession,
    epoch = sessionLifecycleEpoch,
  ) {
    await stopPushEventListeners();
    if (!currentMatchingSession(session, epoch)) return;
    const nextUnlisteners: Array<() => void | Promise<void>> = [];
    const bridge = options.nativeBridge;
    try {
      if (bridge.onPushNotificationReceived) {
        nextUnlisteners.push(
          await bridge.onPushNotificationReceived((notification) => {
            void handlePushNotificationEvent(
              session,
              epoch,
              "received",
              notification,
            );
          }),
        );
        if (!currentMatchingSession(session, epoch)) {
          await stopRegisteredPushEventListeners(nextUnlisteners);
          return;
        }
      }
      if (bridge.onPushNotificationTapped) {
        nextUnlisteners.push(
          await bridge.onPushNotificationTapped((notification) => {
            void handlePushNotificationEvent(
              session,
              epoch,
              "tapped",
              notification,
            );
          }),
        );
        if (!currentMatchingSession(session, epoch)) {
          await stopRegisteredPushEventListeners(nextUnlisteners);
          return;
        }
      }
      if (bridge.onPushTokenRefresh && options.registerPush) {
        nextUnlisteners.push(
          await bridge.onPushTokenRefresh(
            {
              hostUrl: session.hostUrl,
              product: session.product,
            },
            (registration) => {
              void handlePushTokenRefresh(session, epoch, registration);
            },
          ),
        );
        if (!currentMatchingSession(session, epoch)) {
          await stopRegisteredPushEventListeners(nextUnlisteners);
          return;
        }
      }
      pushEventUnlisteners = nextUnlisteners;
    } catch (error) {
      await stopRegisteredPushEventListeners(nextUnlisteners);
      if (currentMatchingSession(session, epoch)) {
        publish({
          pushStatus: mobileErrorMessage(error, copy.pushEventsFailedStatus),
        });
      }
    }
  }

  function currentMatchingSession(
    session: MobileSession,
    epoch = sessionLifecycleEpoch,
  ) {
    if (epoch !== sessionLifecycleEpoch) return undefined;
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
    epoch: number,
    kind: MobilePushNotificationEventKind,
    notification: MobilePushNotification,
  ) {
    const current = currentMatchingSession(session, epoch);
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
      if (currentMatchingSession(session, epoch)) {
        publish({
          pushStatus: mobileErrorMessage(error, copy.pushEventsFailedStatus),
        });
      }
    }
  }

  async function handlePushTokenRefresh(
    session: MobileSession,
    epoch: number,
    registration: MobilePushRegistration,
  ) {
    await enqueuePushOperation(async () => {
      const current = currentMatchingSession(session, epoch);
      if (!current || !options.registerPush) return;
      const previousRegistration = state.pushRegistration;
      if (
        previousRegistration &&
        samePushRegistration(previousRegistration, registration)
      ) {
        publish({ pushStatus: copy.pushTokenRefreshedStatus });
        return;
      }
      publish({
        pushLoading: true,
        pushStatus: copy.pushRegisteringStatus,
      });
      try {
        await options.registerPush({ session: current, registration });
        if (!currentMatchingSession(session, epoch)) {
          await unregisterPushBestEffort(current, registration);
          return;
        }
        if (
          previousRegistration &&
          !samePushRegistration(previousRegistration, registration)
        ) {
          await unregisterPushBestEffort(current, previousRegistration);
          if (!currentMatchingSession(session, epoch)) {
            await unregisterPushBestEffort(current, registration);
            return;
          }
        }
        publish({
          pushRegistration: registration,
          pushStatus: copy.pushTokenRefreshedStatus,
        });
      } catch (error) {
        if (currentMatchingSession(session, epoch)) {
          publish({
            pushStatus: mobileErrorMessage(error, copy.pushFailedStatus),
          });
        }
      } finally {
        if (currentMatchingSession(session, epoch)) {
          publish({ pushLoading: false });
        }
      }
    });
  }

  async function openPendingRoute(session: MobileSession) {
    const pendingRoute = state.pendingRoute;
    if (!pendingRoute || !routeMatchesSession(pendingRoute, session)) return;
    await openRoutePayload(pendingRoute);
  }

  async function refreshHomeForSession(current: MobileSession, epoch: number) {
    if (!options.loadHome || !currentMatchingSession(current, epoch)) return;
    publish({ homeLoading: true, homeStatus: copy.homeLoadingStatus });
    try {
      const session = await freshenSession(current, epoch);
      if (!currentMatchingSession(current, epoch)) return;
      if (session !== current) publish({ session });
      const home = await options.loadHome(session);
      if (!currentMatchingSession(session, epoch)) return;
      publish({
        home,
        homeStatus: copy.homeReadyStatus,
      });
    } catch (error) {
      if (currentMatchingSession(current, epoch)) {
        publish({
          home: undefined,
          homeStatus: mobileErrorMessage(error, copy.homeFailedStatus),
        });
      }
    } finally {
      if (currentMatchingSession(current, epoch)) {
        publish({ homeLoading: false });
      }
    }
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
          status: mobileErrorMessage(error, copy.routeFailedStatus),
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
    return (
      normalizeHostUrl(route.hostUrl) === normalizeHostUrl(session.hostUrl)
    );
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

  async function removeKnownHost(hostUrl: string) {
    try {
      return await removeMobileKnownHost({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
        hostUrl,
      });
    } catch {
      return state.knownHosts;
    }
  }

  async function clearKnownHostList() {
    try {
      return await clearMobileKnownHosts({
        adapter: options.adapter,
        nativeBridge: options.nativeBridge,
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
      const acceptedProducts = options.adapter.acceptAnyConnectProduct
        ? undefined
        : new Set(
            options.adapter.acceptedConnectProducts ?? [
              options.adapter.product,
            ],
          );
      if (
        payload.product &&
        acceptedProducts &&
        !acceptedProducts.has(payload.product)
      ) {
        throw new Error("Mobile connect payload product mismatch.");
      }
      const discovery = await discoverHost({
        hostUrl: payload.hostUrl,
        expectedProduct:
          options.adapter.strictDiscoveryProduct === false
            ? undefined
            : options.adapter.product,
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
        status: mobileErrorMessage(error, "Host connection failed."),
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
      const startEpoch = sessionLifecycleEpoch;
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
      if (startEpoch !== sessionLifecycleEpoch) return;
      if (existingSession) {
        if (shouldLockRestoredSession(options, existingSession)) {
          publish({
            lockedSession: existingSession,
            status: copy.sessionLockedStatus,
          });
        } else {
          await activateSession(
            existingSession,
            copy.sessionRestoredStatus,
            startEpoch,
          );
        }
      }

      if (startEpoch !== sessionLifecycleEpoch && !state.session) return;
      const payload = await options.nativeBridge.getLaunchPayload();
      if (payload) await controller.handleLaunchPayload(payload);
    },
    stop() {
      invalidateSessionLifecycle();
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
          status: mobileErrorMessage(error, copy.routeFailedStatus),
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
    async forgetKnownHost(hostUrl) {
      publish({
        knownHosts: await removeKnownHost(hostUrl),
        status: copy.knownHostRemovedStatus,
      });
    },
    async clearKnownHosts() {
      publish({
        knownHosts: await clearKnownHostList(),
        status: copy.knownHostsClearedStatus,
      });
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
          scope: normalizeOidcScopes(
            options.oidcScopes ?? options.adapter.oidcScopes,
          ),
          fetch: options.fetch,
        });
        publish({ status: copy.openingSignInStatus });
        await options.nativeBridge.openExternalUrl(result.authorizationUrl);
      } catch (error) {
        publish({
          status: mobileErrorMessage(error, copy.signInFailedStatus),
        });
      }
      return {};
    },
    async completeSignIn(callbackUrl) {
      const completionEpoch = sessionLifecycleEpoch;
      publish({ status: "Completing sign-in..." });
      try {
        const session = await completeMobileOidcSignIn({
          adapter: options.adapter,
          nativeBridge: options.nativeBridge,
          callbackUrl,
          persistSession: false,
          fetch: options.fetch,
        });
        if (!(await persistSessionForEpoch(session, completionEpoch))) return;
        await activateSession(session, copy.signedInStatus, completionEpoch);
      } catch (error) {
        if (completionEpoch === sessionLifecycleEpoch) {
          publish({
            status: mobileErrorMessage(error, copy.signInFailedStatus),
          });
        }
      }
    },
    async unlockSession() {
      const current = state.lockedSession;
      if (!current) return;
      const unlockEpoch = sessionLifecycleEpoch;
      const unlocker = options.nativeBridge.authenticateBiometric;
      if (!options.nativeBridge.capabilities.biometricAuth || !unlocker) {
        if (sessionUnlockMode(options) === "required") {
          publish({ status: copy.sessionUnlockUnavailableStatus });
          return;
        }
        publish({ lockedSession: undefined });
        await activateSession(current, copy.sessionRestoredStatus, unlockEpoch);
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
          if (unlockEpoch === sessionLifecycleEpoch) {
            publish({ status: copy.sessionUnlockFailedStatus });
          }
          return;
        }
        if (unlockEpoch !== sessionLifecycleEpoch) return;
        publish({ lockedSession: undefined });
        await activateSession(current, copy.sessionUnlockedStatus, unlockEpoch);
      } catch (error) {
        if (unlockEpoch === sessionLifecycleEpoch) {
          publish({
            status: mobileErrorMessage(error, copy.sessionUnlockFailedStatus),
          });
        }
      } finally {
        if (unlockEpoch === sessionLifecycleEpoch) {
          publish({ unlockLoading: false });
        }
      }
    },
    async refreshHome(current = state.session) {
      if (!current || !options.loadHome) return;
      await refreshHomeForSession(current, sessionLifecycleEpoch);
    },
    async registerPushNotifications(current = state.session) {
      const registerPush = options.registerPush;
      if (!current || !registerPush) return;
      const epoch = sessionLifecycleEpoch;
      await enqueuePushOperation(async () => {
        const active = currentMatchingSession(current, epoch);
        if (!active) return;
        if (!options.nativeBridge.registerPushNotifications) {
          publish({ pushStatus: copy.pushUnavailableStatus });
          return;
        }
        publish({ pushLoading: true, pushStatus: copy.pushRegisteringStatus });
        try {
          const registration =
            await options.nativeBridge.registerPushNotifications({
              hostUrl: active.hostUrl,
              product: active.product,
            });
          if (!currentMatchingSession(current, epoch)) return;
          if (!registration) {
            publish({ pushStatus: copy.pushUnavailableStatus });
            return;
          }
          await registerPush({ session: active, registration });
          if (!currentMatchingSession(current, epoch)) {
            await unregisterPushBestEffort(active, registration);
            return;
          }
          publish({
            pushRegistration: registration,
            pushStatus: copy.pushReadyStatus,
          });
        } catch (error) {
          if (currentMatchingSession(current, epoch)) {
            publish({
              pushStatus: mobileErrorMessage(error, copy.pushFailedStatus),
            });
          }
        } finally {
          if (currentMatchingSession(current, epoch)) {
            publish({ pushLoading: false });
          }
        }
      });
    },
    async signOut() {
      const currentSession = state.session;
      const currentPushRegistration = state.pushRegistration;
      invalidateSessionLifecycle();
      publish({
        connectPayload: undefined,
        discovery: undefined,
        pendingRoute: undefined,
        session: undefined,
        lockedSession: undefined,
        unlockLoading: false,
        home: undefined,
        homeStatus: "",
        homeLoading: false,
        pushRegistration: undefined,
        lastPushNotification: undefined,
        pushStatus: "",
        pushLoading: false,
        status: copy.signedOutStatus,
      });

      const listenerCleanup = stopPushEventListeners();
      const pushCleanup = enqueuePushOperation(async () => {
        await Promise.allSettled([
          currentSession && currentPushRegistration
            ? unregisterPushBestEffort(currentSession, currentPushRegistration)
            : Promise.resolve(),
          unregisterNativePushBestEffort(),
        ]);
      });
      await enqueueSessionStorageOperation(async () => {
        await clearMobileSession({
          adapter: options.adapter,
          nativeBridge: options.nativeBridge,
        });
      });
      await settleWithin(
        Promise.allSettled([listenerCleanup, pushCleanup]),
        signOutCleanupTimeoutMs,
      );
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

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
}

function normalizeOidcScopes(scopes: readonly string[] | undefined) {
  if (!scopes) return undefined;
  const normalized = scopes
    .flatMap((scope) => scope.trim().split(/\s+/u))
    .filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)].join(" ") : undefined;
}

function createClientCopy(
  options: CreateMobileClientControllerOptions,
): Required<MobileClientCopy> {
  const hostNoun = options.adapter.hostNoun;
  const homeLabel = options.homeLabel ?? "home";
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
      options.copy?.sessionUnlockFailedStatus ?? "Session unlock was canceled.",
    unlockSessionLabel: options.copy?.unlockSessionLabel ?? "Unlock session",
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
      options.copy?.pushNotificationTappedStatus ?? "Push notification opened.",
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
    knownHostRemovedStatus:
      options.copy?.knownHostRemovedStatus ?? "Recent host removed.",
    knownHostsClearedStatus:
      options.copy?.knownHostsClearedStatus ?? "Recent hosts cleared.",
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

function samePushRegistration(
  left: MobilePushRegistration,
  right: MobilePushRegistration,
): boolean {
  return (
    left.token === right.token &&
    left.provider === right.provider &&
    left.environment === right.environment
  );
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
