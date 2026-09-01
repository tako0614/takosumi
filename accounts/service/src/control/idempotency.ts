/**
 * Idempotency-Key support for the session-authed capsule write lane.
 *
 * The install lane is where a duplicate POST hurts most: a retried
 * "add this service" (a flaky network, an impatient double-click, a mobile
 * client resuming) used to create a SECOND Capsule with real provider
 * resources behind it. The portable host idempotency coordinator already
 * solves exactly this for the Resource/Form lanes — reserve the
 * `(workspace, actor, key)` scope, execute once, store the wire response, and
 * replay it byte-for-byte on a retry — so this module re-points that proven
 * mechanism at the capsule routes instead of inventing a parallel one.
 *
 * The header stays OPTIONAL here: a caller that omits it gets today's
 * behavior. Sending one is what buys the guarantee.
 */
import type {
  PortableHostIdempotencyCoordinator,
  PortableHostSuccessWireResponse,
} from "../../../../core/api/portable_host_idempotency.ts";
import { PortableHostIdempotencyError } from "../../../../core/api/portable_host_idempotency.ts";
import { errorJson } from "../http-helpers.ts";
import type { ControlDispatchContext } from "./shared.ts";

/** Same shape rule the Resource lane enforces for the header. */
function isValidIdempotencyKey(value: string): boolean {
  return (
    value.length >= 8 &&
    value.length <= 128 &&
    // Printable ASCII only: the key is echoed back in a response header.
    !/[^\x21-\x7e]/u.test(value)
  );
}

async function wireResponseFrom(
  response: Response,
): Promise<PortableHostSuccessWireResponse> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: new Uint8Array(await response.clone().arrayBuffer()),
  };
}

function responseFromWire(wire: PortableHostSuccessWireResponse): Response {
  const headers = new Headers();
  for (const [name, value] of wire.headers) headers.append(name, value);
  // Mark the replay so a client (and an operator reading a trace) can tell a
  // deduplicated retry from a fresh execution.
  headers.set("idempotency-replayed", "true");
  // Copy into a plain ArrayBuffer: the stored body may be backed by a
  // SharedArrayBuffer-typed view, which BodyInit does not accept.
  const body = new Uint8Array(wire.body).slice().buffer;
  return new Response(body, {
    status: wire.status,
    statusText: wire.statusText,
    headers,
  });
}

/**
 * Runs one capsule-lane write under an Idempotency-Key when the caller sent
 * one and the host composed a coordinator; otherwise runs `execute` directly.
 *
 * Only a 2xx is recorded: a failed attempt must stay retryable, and the
 * reservation is released so the same key can be used again.
 */
export async function withCapsuleWriteIdempotency(
  ctx: ControlDispatchContext,
  input: {
    readonly workspaceId: string;
    readonly body: Uint8Array;
  },
  execute: () => Promise<Response>,
): Promise<Response> {
  const coordinator = ctx.idempotency;
  const rawKey = ctx.request.headers.get("idempotency-key")?.trim();
  if (!coordinator || !rawKey) return await execute();
  if (!isValidIdempotencyKey(rawKey)) {
    return errorJson(
      "invalid_request",
      "Idempotency-Key must be 8-128 printable ASCII characters",
      400,
      ctx.request,
    );
  }

  const request = {
    actor: {
      actorAccountId: ctx.session.subject,
      workspaceId: input.workspaceId,
      roles: [],
      requestId: crypto.randomUUID(),
    },
    space: input.workspaceId,
    idempotencyKey: rawKey,
    method: ctx.request.method,
    requestTarget: `${ctx.url.pathname}${ctx.url.search}`,
    body: input.body,
  };

  let reserved: Awaited<ReturnType<typeof coordinator.reserve>>;
  try {
    reserved = await coordinator.reserve(request);
  } catch (error) {
    if (error instanceof PortableHostIdempotencyError) {
      // The same key with a DIFFERENT request is a client bug, not a retry.
      return errorJson(
        "invalid_request",
        "Idempotency-Key was already used for a different request",
        409,
        ctx.request,
      );
    }
    throw error;
  }
  if (reserved.kind === "replay") {
    return responseFromWire(reserved.response);
  }
  if (reserved.kind === "in_progress") {
    // The first attempt is still running. Answering 409 (rather than waiting)
    // keeps the request bounded; the client retries and gets the replay.
    return errorJson(
      "conflict",
      "a request with this Idempotency-Key is still in progress",
      409,
      ctx.request,
      { "retry-after": "2" },
    );
  }

  let response: Response;
  try {
    response = await execute();
  } catch (error) {
    // An exception is an AMBIGUOUS outcome: the handler may have created a
    // Capsule and then failed while wiring it up. Releasing the key here let a
    // retry create a second one with real provider resources behind it —
    // exactly what this module exists to prevent. The reservation stays, so
    // the retry is refused rather than duplicated.
    throw error;
  }
  // A 4xx is the request being rejected before any canonical mutation, so the
  // key is freed for a corrected retry. A 5xx is ambiguous like an exception
  // and keeps the reservation.
  if (response.status >= 400 && response.status < 500) {
    await coordinator.release(reserved.reservation).catch(() => undefined);
    return response;
  }
  if (response.status < 200 || response.status >= 300) {
    return response;
  }
  const wire = await wireResponseFrom(response);
  const stored = await coordinator.storeSuccess(reserved.reservation, wire);
  return responseFromWire(stored);
}
