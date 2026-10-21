/**
 * Same-origin Hosted session availability before protected dashboard reads.
 * The health response never supplies account, Workspace, or API permission;
 * every caller still sends its original canonical request.
 */
const HEALTH_PATH = "/auth/oidc/session";
const ABSENCE_HEADER = "x-takosumi-shared-auth-absent";
const HEALTH_DEADLINE_MS = 40_000;

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
let healthInflight: Promise<RoutePresence> | undefined;
let initialInflight: Promise<RoutePresence> | undefined;
let generation = 0;
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

/** Clear local knowledge; logout cannot cancel another caller's in-flight read. */
export function clearSharedAuthSessionPreflight(): void {
  generation += 1;
  knownRoute = undefined;
  initialFailure = undefined;
  healthInflight = undefined;
  initialInflight = undefined;
}

export function isKnownSharedAuthRoutePresent(): boolean {
  return knownRoute === "present";
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

function parseHealth(response: Response, body: unknown): RoutePresence {
  const json = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() === "application/json";
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

async function readHealth(): Promise<RoutePresence> {
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
  const work = (async () => {
    const response = await fetch(HEALTH_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
    return parseHealth(response, await readBody(response));
  })();
  try {
    return await Promise.race([work, deadline]);
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function startHealth(initial: boolean): Promise<RoutePresence> {
  if (healthInflight) {
    if (initial) initialInflight = healthInflight;
    return healthInflight;
  }
  const request = readHealth().finally(() => {
    if (healthInflight === request) healthInflight = undefined;
  });
  healthInflight = request;
  if (initial) initialInflight = request;
  return request;
}

/** The initial guarded read records only genuine route presence. */
export async function probeInitialSharedAuthSession(): Promise<{
  readonly route: RoutePresence;
  readonly ticket: InitialSharedAuthHealthTicket;
}> {
  const capturedGeneration = generation;
  const request = startHealth(true);
  try {
    const route = await request;
    if (capturedGeneration !== generation) {
      throw new SharedAuthSessionPreflightError(
        0, "", new Headers(), undefined,
        "Hosted session probe was superseded.",
      );
    }
    knownRoute = route;
    initialFailure = undefined;
    const ticket = Object.freeze({}) as InitialSharedAuthHealthTicket;
    tickets.set(ticket, { generation, route });
    return { route, ticket };
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
