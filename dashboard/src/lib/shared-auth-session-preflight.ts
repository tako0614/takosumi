/**
 * Same-origin Hosted session availability before protected dashboard reads.
 * The health response never supplies account, Workspace, or API permission;
 * every caller still sends its original canonical request.
 */
const HEALTH_PATH = "/auth/oidc/session";
const ABSENCE_HEADER = "x-takosumi-shared-auth-absent";
export const SHARED_AUTH_READ_HEADER = "x-takosumi-shared-auth-read";
const HEALTH_DEADLINE_MS = 40_000;
const RECENT_READ_PROBE_MS = 5_000;
const HOSTED_SESSION_RETRY_MS = [300, 900, 1_800] as const;

type RoutePresence = "present" | "absent";
type RouteKnowledge = RoutePresence | "failed";

declare const initialHealthTicketBrand: unique symbol;
export interface InitialSharedAuthHealthTicket {
  readonly [initialHealthTicketBrand]: true;
}

export class SharedAuthSessionPreflightError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly headers: Headers,
    readonly body: unknown,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SharedAuthSessionPreflightError";
  }
}

let knownRoute: RouteKnowledge | undefined;
let initialFailure: SharedAuthSessionPreflightError | undefined;
let establishedHostedRoute = false;
let healthInflight: Promise<RoutePresence> | undefined;
let initialInflight: Promise<RoutePresence> | undefined;
let generation = 0;
let availabilityGeneration = 0;
let lastPresentAt: number | undefined;
const tickets = new WeakMap<
  object,
  { readonly generation: number; readonly route: RoutePresence }
>();

function aborted(): DOMException {
  return new DOMException("Request was aborted.", "AbortError");
}

export function throwIfSharedAuthCallerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}

/** An authoritative 401 retires any recently shared availability observation. */
export function invalidateRecentSharedAuthProbe(): void {
  availabilityGeneration += 1;
  lastPresentAt = undefined;
}

/** Clear local knowledge; logout cannot cancel another caller's in-flight read. */
export function clearSharedAuthSessionPreflight(): void {
  generation += 1;
  invalidateRecentSharedAuthProbe();
  knownRoute = undefined;
  initialFailure = undefined;
  establishedHostedRoute = false;
  healthInflight = undefined;
  initialInflight = undefined;
}

export function isKnownSharedAuthRoutePresent(): boolean {
  return knownRoute === "present";
}

export function isKnownSharedAuthRouteAbsent(): boolean {
  return knownRoute === "absent";
}

function readBody(response: Response): Promise<unknown> {
  return response.text().then((text) => {
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  });
}

function isJson(headers: Headers): boolean {
  return headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() === "application/json";
}

export function isHostedSessionUnavailable(
  error: unknown,
): error is SharedAuthSessionPreflightError {
  if (!(error instanceof SharedAuthSessionPreflightError) ||
    error.status !== 503 || !isJson(error.headers)) return false;
  const body = error.body as { error?: { code?: unknown } } | null | undefined;
  return body?.error?.code === "oidc_unavailable";
}

function parseHealth(response: Response, body: unknown): RoutePresence {
  const json = isJson(response.headers);
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  if (
    response.status === 404 && json && record &&
    Object.keys(record).length === 1 && record.error === "not_found" &&
    response.headers.get(ABSENCE_HEADER) === "1" &&
    response.headers.get("cache-control")?.split(",")
      .some((directive) => directive.trim().toLowerCase() === "no-store")
  ) return "absent";
  if (
    json && record && Object.keys(record).length === 1 &&
    ((response.status === 200 && record.authenticated === true) ||
      (response.status === 401 && record.authenticated === false))
  ) return "present";
  throw new SharedAuthSessionPreflightError(
    response.status,
    response.statusText,
    new Headers(response.headers),
    body,
    response.ok
      ? "Hosted session probe did not return authenticated status."
      : `Hosted session probe failed (${response.status}).`,
  );
}

async function retryHostedSessionRead<T>(
  signal: AbortSignal,
  read: () => Promise<T>,
  isAbsent: (result: T) => boolean,
): Promise<T> {
  let unavailable: SharedAuthSessionPreflightError | undefined;
  for (const delay of [0, ...HOSTED_SESSION_RETRY_MS]) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    throwIfSharedAuthCallerAborted(signal);
    let result: T;
    try {
      result = await read();
    } catch (error) {
      // A concurrent Hosted grant check can briefly occupy the session. Only
      // repeat the RP probe; an explicit Retry-After takes precedence.
      if (!isHostedSessionUnavailable(error) || error.headers.has("retry-after")) throw error;
      unavailable = error;
      continue;
    }
    // A later absence cannot select an ordinary session after explicit
    // Hosted unavailability during the same probe.
    if (unavailable && isAbsent(result)) throw unavailable;
    return result;
  }
  throw unavailable;
}

async function withHostedSessionDeadline<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SharedAuthSessionPreflightError(
        0,
        "",
        new Headers(),
        undefined,
        "Hosted session probe timed out.",
      ));
      controller.abort();
    }, HEALTH_DEADLINE_MS);
  });
  try {
    return await Promise.race([read(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readHealth(signal: AbortSignal, assertCurrent?: () => void): Promise<RoutePresence> {
  try {
    return await retryHostedSessionRead(signal, async () => {
      assertCurrent?.();
      const response = await fetch(HEALTH_PATH, {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "include",
        cache: "no-store",
        signal,
      });
      return parseHealth(response, await readBody(response));
    }, (route) => route === "absent");
  } catch (error) {
    if (error instanceof SharedAuthSessionPreflightError) throw error;
    throw new SharedAuthSessionPreflightError(
      0,
      "",
      new Headers(),
      undefined,
      "Hosted session probe transport is unavailable.",
      error,
    );
  }
}

function startHealth(initial: boolean): Promise<RoutePresence> {
  if (healthInflight) {
    if (initial) initialInflight = healthInflight;
    return healthInflight;
  }
  lastPresentAt = undefined;
  const observedGeneration = availabilityGeneration;
  const request = withHostedSessionDeadline(readHealth).then((route) => {
    if (route === "present" && observedGeneration === availabilityGeneration) {
      lastPresentAt = Date.now();
    }
    return route;
  }).finally(() => {
    if (healthInflight === request) healthInflight = undefined;
  });
  healthInflight = request;
  if (initial) initialInflight = request;
  return request;
}

/** The initial guarded read records only genuine route presence. */
export async function probeInitialSharedAuthSession<T extends { readonly authenticated: boolean } = never>(
  readBootstrap?: (signal: AbortSignal) => Promise<T | undefined>,
): Promise<{
  readonly route: RoutePresence;
  readonly ticket: InitialSharedAuthHealthTicket;
  readonly bootstrap?: T;
}> {
  const capturedGeneration = generation;
  const capturedAvailability = availabilityGeneration;
  let bootstrap: T | undefined;
  const assertCurrent = () => {
    if (capturedGeneration !== generation) {
      throw new SharedAuthSessionPreflightError(
        0, "", new Headers(), undefined, "Hosted session probe was superseded.",
      );
    }
  };
  const request = initialInflight ?? (readBootstrap && !healthInflight
    ? Promise.resolve().then(() => withHostedSessionDeadline(async (signal): Promise<RoutePresence> => {
      bootstrap = await retryHostedSessionRead(signal, () => {
        assertCurrent();
        return readBootstrap(signal);
      }, (result) => result === undefined);
      assertCurrent();
      throwIfSharedAuthCallerAborted(signal);
      const route = bootstrap ? "present" : await readHealth(signal, assertCurrent);
      assertCurrent();
      throwIfSharedAuthCallerAborted(signal);
      if (route === "present" && capturedAvailability === availabilityGeneration) {
        if (!bootstrap || bootstrap.authenticated) lastPresentAt = Date.now();
        else invalidateRecentSharedAuthProbe();
      }
      return route;
    }))
    : startHealth(true));
  initialInflight = request;
  try {
    const route = await request;
    assertCurrent();
    if (route === "absent" && establishedHostedRoute) {
      throw new SharedAuthSessionPreflightError(
        404, "", new Headers(), undefined,
        "Established Hosted session route became unavailable.",
      );
    }
    if (route === "present") establishedHostedRoute = true;
    knownRoute = route;
    initialFailure = undefined;
    const ticket = Object.freeze({}) as InitialSharedAuthHealthTicket;
    tickets.set(ticket, { generation, route });
    return { route, ticket, ...(bootstrap ? { bootstrap } : {}) };
  } catch (error) {
    if (capturedGeneration === generation) {
      knownRoute = "failed";
      initialFailure = error instanceof SharedAuthSessionPreflightError
        ? error
        : new SharedAuthSessionPreflightError(
          0, "", new Headers(), undefined,
          "Hosted session probe is unavailable.", error,
        );
    }
    throw error;
  } finally {
    // Keep concurrent canonical reads waiting until route knowledge is set.
    if (initialInflight === request) initialInflight = undefined;
  }
}

function forCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfSharedAuthCallerAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The server must still handle a reused read through the shared profile. */
export function canReuseRecentSharedAuthProbe(): boolean {
  if (knownRoute !== "present" || initialInflight || healthInflight || lastPresentAt === undefined) {
    return false;
  }
  const age = Date.now() - lastPresentAt;
  return age >= 0 && age < RECENT_READ_PROBE_MS;
}

/** A previous Worker version may lack the request fence after rollback. */
export function requireSharedAuthReadResponse(response: Response): void {
  if ((response.ok || response.status === 404) &&
    response.headers.get(SHARED_AUTH_READ_HEADER) !== "1") {
    invalidateRecentSharedAuthProbe();
    throw new SharedAuthSessionPreflightError(
      503, "", new Headers(), undefined, "Hosted session route became unavailable.",
    );
  }
}

/**
 * Returns undefined when ordinary OSS has no known Hosted route. A one-use
 * ticket carries an already completed initial health read into its matching
 * canonical bootstrap, avoiding a second serial health request.
 */
export function preflightSharedAuthSession(
  signal?: AbortSignal,
  initialTicket?: InitialSharedAuthHealthTicket,
): Promise<void> | undefined {
  throwIfSharedAuthCallerAborted(signal);
  if (initialTicket) {
    const held = tickets.get(initialTicket);
    if (!held || held.generation !== generation || held.route !== knownRoute) {
      throw new SharedAuthSessionPreflightError(
        0, "", new Headers(), undefined,
        "Hosted session probe handoff is invalid.",
      );
    }
    tickets.delete(initialTicket);
    return undefined;
  }
  const pendingInitial = initialInflight;
  if (pendingInitial) {
    const capturedGeneration = generation;
    return forCaller(pendingInitial, signal).then((route) => {
      throwIfSharedAuthCallerAborted(signal);
      if (generation !== capturedGeneration) {
        throw new SharedAuthSessionPreflightError(
          0, "", new Headers(), undefined,
          "Hosted session probe was superseded.",
        );
      }
      if (route === "absent" && establishedHostedRoute) {
        throw new SharedAuthSessionPreflightError(
          404, "", new Headers(), undefined,
          "Established Hosted session route became unavailable.",
        );
      }
      if (knownRoute === "failed") {
        throw initialFailure ?? new SharedAuthSessionPreflightError(
          0, "", new Headers(), undefined,
          "Hosted session probe is unavailable.",
        );
      }
      if (route !== "present" && route !== "absent") {
        throw new Error("Hosted session route is invalid.");
      }
    });
  }
  if (knownRoute === "failed") {
    throw initialFailure ?? new SharedAuthSessionPreflightError(
      0, "", new Headers(), undefined,
      "Hosted session probe is unavailable.",
    );
  }
  if (knownRoute !== "present") return undefined;
  const capturedGeneration = generation;
  return forCaller(startHealth(false), signal).then((route) => {
    throwIfSharedAuthCallerAborted(signal);
    if (generation !== capturedGeneration) {
      throw new SharedAuthSessionPreflightError(
        0, "", new Headers(), undefined,
        "Hosted session probe was superseded.",
      );
    }
    if (route !== "present") {
      // A once-present RP cannot be silently downgraded to ordinary OSS.
      throw new SharedAuthSessionPreflightError(
        404, "", new Headers(), undefined,
        "Hosted session route became unavailable.",
      );
    }
  });
}
