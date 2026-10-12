import { PartitionedSecretBoundaryCrypto } from "../../adapters/secret-store/memory.ts";
import type {
  PrivateRunFileAuthority,
  PrivateRunFileOperation,
  PrivateRunFileScope,
} from "./mod.ts";

const PURPOSE = "takosumi.private-run-files.grant@v1";
const AUDIENCE = "takosumi.private-run-files.http@v1";
const PREFIX = "prfg1.";
// Covers the Core runner's 900-second fallback deadline plus its 60-second
// dispatch margin; longer profiles require an explicit renewal design.
const MAX_TTL_MS = 20 * 60 * 1000;
const MAX_TOKEN_LENGTH = 8192;
const aad = new TextEncoder().encode(`${PURPOSE}\0${AUDIENCE}`);
const validOperations = new Set<PrivateRunFileOperation>([
  "read",
  "commit",
  "resolve",
]);

export interface PrivateRunFileGrantInput {
  readonly scope: PrivateRunFileScope;
  readonly authority: PrivateRunFileAuthority;
  readonly operations: readonly PrivateRunFileOperation[];
  /** Unix epoch milliseconds. A grant cannot outlive twenty minutes. */
  readonly expiresAt: number;
}

export interface PrivateRunFileGrantClaims extends PrivateRunFileGrantInput {
  readonly issuedAt: number;
}

export interface PrivateRunFileGrantCodec {
  mint(input: PrivateRunFileGrantInput): Promise<string>;
  open(token: string): Promise<PrivateRunFileGrantClaims>;
}

export class PrivateRunFileGrantError extends Error {
  constructor() {
    super("private run file grant rejected");
    this.name = "PrivateRunFileGrantError";
  }
}

/**
 * A bearer capability, not a lease token. Only Core can open its authenticated
 * payload. The repository still checks the current Run lease for every access.
 */
export function createPrivateRunFileGrantCodec(input: {
  readonly cryptoBoundary: PartitionedSecretBoundaryCrypto;
  readonly now?: () => number;
}): PrivateRunFileGrantCodec {
  if (!(input.cryptoBoundary instanceof PartitionedSecretBoundaryCrypto)) {
    throw new PrivateRunFileGrantError();
  }
  const now = input.now ?? Date.now;
  return {
    async mint(request) {
      const issuedAt = now();
      const claims = validateClaims({
        purpose: PURPOSE,
        audience: AUDIENCE,
        scope: request.scope,
        authority: request.authority,
        operations: request.operations,
        issuedAt,
        expiresAt: request.expiresAt,
      }, issuedAt, true);
      try {
        const ciphertext = await input.cryptoBoundary.seal(
          JSON.stringify({ purpose: PURPOSE, audience: AUDIENCE, ...claims }),
          PURPOSE,
          aad,
        );
        const token = `${PREFIX}${encodeBase64Url(ciphertext)}`;
        if (token.length > MAX_TOKEN_LENGTH) throw new PrivateRunFileGrantError();
        return token;
      } catch {
        throw new PrivateRunFileGrantError();
      }
    },
    async open(token) {
      if (typeof token !== "string" || !token.startsWith(PREFIX) ||
        token.length > MAX_TOKEN_LENGTH) {
        throw new PrivateRunFileGrantError();
      }
      try {
        const plaintext = await input.cryptoBoundary.open(
          decodeBase64Url(token.slice(PREFIX.length)),
          PURPOSE,
          aad,
        );
        return validateClaims(JSON.parse(plaintext), now(), false);
      } catch {
        throw new PrivateRunFileGrantError();
      }
    },
  };
}

function validateClaims(value: unknown, current: number, mint: boolean): PrivateRunFileGrantClaims {
  if (!record(value) || value.purpose !== PURPOSE || value.audience !== AUDIENCE ||
    !record(value.scope) || !record(value.authority) ||
    !finiteTime(current) || !finiteTime(value.issuedAt) ||
    !finiteTime(value.expiresAt) ||
    value.issuedAt > current + 30_000 ||
    (mint && value.issuedAt !== current) ||
    value.expiresAt <= current ||
    value.expiresAt <= value.issuedAt ||
    value.expiresAt - value.issuedAt > MAX_TTL_MS ||
    !validText(value.scope.workspaceId) ||
    !validText(value.scope.capsuleId) ||
    !validText(value.scope.environment) ||
    !validText(value.scope.slot) ||
    !validText(value.authority.runId) ||
    !validText(value.authority.leaseToken) ||
    !Number.isSafeInteger(value.authority.executionAuthorityEpoch) ||
    (value.authority.executionAuthorityEpoch as number) < 1 ||
    !Array.isArray(value.operations) || value.operations.length === 0 ||
    value.operations.length > validOperations.size ||
    !value.operations.every((operation) => validOperations.has(operation)) ||
    new Set(value.operations).size !== value.operations.length) {
    throw new PrivateRunFileGrantError();
  }
  return {
    scope: {
      workspaceId: value.scope.workspaceId as string,
      capsuleId: value.scope.capsuleId as string,
      environment: value.scope.environment as string,
      slot: value.scope.slot as string,
    },
    authority: {
      runId: value.authority.runId as string,
      executionAuthorityEpoch: value.authority.executionAuthorityEpoch as number,
      leaseToken: value.authority.leaseToken as string,
    },
    operations: [...value.operations] as PrivateRunFileOperation[],
    issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 512 && value.trim() === value;
}

function finiteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new PrivateRunFileGrantError();
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
