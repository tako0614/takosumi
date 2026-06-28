import type {
  ActorContext,
  GroupCreateRequest,
  GroupSummary,
  SpaceCreateRequest,
  SpaceSummary,
} from "./types.ts";
import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
import {
  assertNoCanonicalDelimiter,
  hmacSha256Hex,
  readHeader,
  TAKOSUMI_INTERNAL_ACTOR_HEADER,
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS,
  TAKOSUMI_INTERNAL_TIMESTAMP_HEADER,
  timestampWithinSkew,
  timingSafeEqualHex,
} from "./internal-crypto.ts";

export {
  TAKOSUMI_INTERNAL_ACTOR_HEADER,
  TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS,
  TAKOSUMI_INTERNAL_TIMESTAMP_HEADER,
};

export type TakosumiActorContext = ActorContext;

export interface InternalSpaceRequest extends Partial<SpaceCreateRequest> {
  actor: TakosumiActorContext;
  workspaceId?: string;
}

export interface InternalSpaceSummary
  extends Pick<SpaceSummary, "id" | "name"> {
  actorAccountId: string;
}

export interface InternalGroupRequest extends Partial<GroupCreateRequest> {
  actor: TakosumiActorContext;
  workspaceId: string;
  groupId?: string;
}

export type InternalGroupSummary = GroupSummary;

export const TAKOSUMI_INTERNAL_PATHS = {
  spaces: `${INTERNAL_V1_PREFIX}/spaces`,
  groups: `${INTERNAL_V1_PREFIX}/groups`,
} as const;

export interface SignedInternalResponseInput {
  method: string;
  path: string;
  status: number;
  body: string;
  timestamp: string;
  requestId: string;
}

export interface InternalResponseSigningInput {
  method: string;
  path: string;
  status: number;
  body: string;
  timestamp: string;
  requestId: string;
  secret: string;
}

export interface SignedInternalResponse {
  headers: Record<string, string>;
}

export function canonicalInternalResponse(
  input: SignedInternalResponseInput,
): string {
  // Only the structured prefix fields are guarded against newlines: a `\n` in
  // any of them could shift field boundaries and make two distinct tuples
  // canonicalize identically. The trailing `body` is exempt because it is the
  // last field, so newlines in it cannot reassign earlier field bytes, and
  // response bodies (e.g. pretty-printed JSON) legitimately contain newlines.
  const prefix = {
    version: "takosumi-internal-response-v1",
    method: input.method.toUpperCase(),
    path: input.path,
    status: String(input.status),
    timestamp: input.timestamp,
    requestId: input.requestId,
  };
  assertNoCanonicalDelimiter(prefix);
  return [...Object.values(prefix), input.body].join("\n");
}

export async function signInternalResponse(
  input: InternalResponseSigningInput,
): Promise<SignedInternalResponse> {
  const signature = await hmacSha256Hex(
    input.secret,
    canonicalInternalResponse(input),
  );
  return {
    headers: {
      [TAKOSUMI_INTERNAL_REQUEST_ID_HEADER]: input.requestId,
      [TAKOSUMI_INTERNAL_TIMESTAMP_HEADER]: input.timestamp,
      [TAKOSUMI_INTERNAL_SIGNATURE_HEADER]: signature,
    },
  };
}

export async function verifyInternalResponseSignature(
  input: SignedInternalResponseInput & {
    secret: string;
    signature: string;
  },
): Promise<boolean> {
  const canonical = canonicalInternalResponse(input);
  const expectedSignature = await hmacSha256Hex(input.secret, canonical);
  return timingSafeEqualHex(expectedSignature, input.signature);
}

/**
 * Verifies a signed internal *response* from its headers.
 *
 * Replay protection asymmetry (intentional): unlike the request path
 * (`verifyTakosumiInternalRequestFromHeaders`), the response envelope binds
 * only method/path/status/timestamp/requestId/body — there is no per-response
 * nonce and no `recordNonce` single-use hook. A captured signed response stays
 * valid for as long as its timestamp is within the clock-skew window
 * (`maxClockSkewMs`, default 5 minutes). This is acceptable because a response
 * is verified by the original caller against the specific request it just
 * issued: the `requestId` in the response must match the in-flight request
 * (`expectedRequestId`), so a response captured from one exchange cannot be
 * usefully replayed into a different one. The skew window is therefore the
 * deliberate replay-protection boundary for responses; callers who want it
 * tighter should pass a smaller `maxClockSkewMs`.
 */
export function verifySignedInternalResponseFromHeaders(
  input: {
    method: string;
    path: string;
    status: number;
    body: string;
    expectedRequestId?: string;
    secret: string;
    headers: Headers | Record<string, string>;
    now?: () => Date;
    maxClockSkewMs?: number;
  },
): Promise<boolean> {
  const signature = readHeader(
    input.headers,
    TAKOSUMI_INTERNAL_SIGNATURE_HEADER,
  );
  const timestamp = readHeader(
    input.headers,
    TAKOSUMI_INTERNAL_TIMESTAMP_HEADER,
  );
  const requestId = readHeader(
    input.headers,
    TAKOSUMI_INTERNAL_REQUEST_ID_HEADER,
  );
  if (!signature || !timestamp || !requestId) return Promise.resolve(false);
  if (!timestampWithinSkew(timestamp, input)) return Promise.resolve(false);
  if (input.expectedRequestId && input.expectedRequestId !== requestId) {
    return Promise.resolve(false);
  }
  return verifyInternalResponseSignature({
    method: input.method,
    path: input.path,
    status: input.status,
    body: input.body,
    timestamp,
    requestId,
    secret: input.secret,
    signature,
  });
}
