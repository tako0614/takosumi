import type {
  ActorContext,
  GroupCreateRequest,
  GroupSummary,
  SpaceCreateRequest,
  SpaceSummary,
} from "./types.ts";

const textEncoder = new TextEncoder();

export const TAKOSUMI_INTERNAL_SIGNATURE_HEADER =
  "x-takosumi-internal-signature";
export const TAKOSUMI_INTERNAL_TIMESTAMP_HEADER =
  "x-takosumi-internal-timestamp";
export const TAKOSUMI_INTERNAL_REQUEST_ID_HEADER = "x-takosumi-request-id";
export const TAKOSUMI_INTERNAL_ACTOR_HEADER = "x-takosumi-actor-context";
export const TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export type TakosumiActorContext = ActorContext;

export interface InternalSpaceRequest extends Partial<SpaceCreateRequest> {
  actor: TakosumiActorContext;
  spaceId?: string;
}

export interface InternalSpaceSummary
  extends Pick<SpaceSummary, "id" | "name"> {
  actorAccountId: string;
}

export interface InternalGroupRequest extends Partial<GroupCreateRequest> {
  actor: TakosumiActorContext;
  spaceId: string;
  groupId?: string;
}

export type InternalGroupSummary = GroupSummary;

export const TAKOSUMI_INTERNAL_PATHS = {
  spaces: "/api/internal/v1/spaces",
  groups: "/api/internal/v1/groups",
  deployments: "/api/internal/v1/deployments",
  deploymentApply: "/api/internal/v1/deployments/:deploymentId/apply",
} as const;

export type TakosumiInternalPath =
  (typeof TAKOSUMI_INTERNAL_PATHS)[keyof typeof TAKOSUMI_INTERNAL_PATHS];

export const TAKOSUMI_RUNTIME_INTERNAL_PATHS = {
  services: "/api/internal/v1/runtime/services",
  resources: "/api/internal/v1/runtime/resources",
  sessions: "/api/internal/v1/runtime/sessions",
} as const;

export type TakosumiRuntimeInternalPath =
  (typeof TAKOSUMI_RUNTIME_INTERNAL_PATHS)[
    keyof typeof TAKOSUMI_RUNTIME_INTERNAL_PATHS
  ];

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
  return [
    "takosumi-internal-response-v1",
    input.method.toUpperCase(),
    input.path,
    String(input.status),
    input.timestamp,
    input.requestId,
    input.body,
  ].join("\n");
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

function timestampWithinSkew(
  timestamp: string,
  input: {
    readonly now?: () => Date;
    readonly maxClockSkewMs?: number;
  },
): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const maxClockSkewMs = input.maxClockSkewMs ??
    TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS;
  if (!Number.isFinite(maxClockSkewMs)) return true;
  const now = (input.now?.() ?? new Date()).getTime();
  return Math.abs(now - parsed) <= maxClockSkewMs;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(message),
  );
  return toHex(signature);
}

function readHeader(
  headers: Headers | Record<string, string>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
