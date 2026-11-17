import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { TakosumiAccountRecord } from "./store.ts";
import { hostedIssuerSessionId } from "./hosted-oidc-profile.ts";

/** Private verifier; never include it in account projections. */
export interface PasswordCredential {
  subject: TakosumiSubject;
  passwordHash: string;
  version: number;
}

export interface PasswordWriteAuthorization {
  sessionId: string;
  generation: number;
  now: number;
  verifiedEmail: string;
  /** Deadline of recent-session proof; omitted only after current-password proof. */
  freshUntil?: number;
}

export interface PasswordAuthStore {
  findBySubject(subject: TakosumiSubject): Promise<PasswordCredential | undefined>;
  create(credential: PasswordCredential, authorization: PasswordWriteAuthorization): Promise<boolean>;
  /** CAS plus account-session/OAuth invalidation in the same commit. */
  replace(expectedVersion: number, credential: PasswordCredential, now: number, authorization: PasswordWriteAuthorization): Promise<boolean>;
  consumeAttempt(key: string, now: number, limit: number, windowMs: number): Promise<boolean>;
}

export const PASSWORD_ATTEMPT_SWEEP_LIMIT = 64;

export function memoryPasswordSubjectActive(records: ReadonlyMap<string, unknown>, subject: TakosumiSubject): boolean {
  const lock = records.get(`identity_merge_locks\n${subject}`) as { operationId: string } | undefined;
  const operation = lock ? records.get(`identity_merge_operations\n${lock.operationId}`) as { status: string } | undefined : undefined;
  return !records.has(`canonical_accounts\n${subject}`) && (!lock || operation?.status === "active");
}

export function memoryPasswordRevocationAllowed(records: ReadonlyMap<string, unknown>, subject: TakosumiSubject): boolean {
  // Enrollment always includes this account-generation parent alongside its
  // grant/issuer/client parents. Closing it needs the existing delivery protocol.
  for (const [key, value] of records) {
    const parent = value as { scope?: { kind?: string; subject?: string } };
    if (key.startsWith("financial_source_parents\n") &&
      parent.scope?.kind === "account-generation" && parent.scope.subject === subject) return false;
  }
  return true;
}

export function assertPasswordAuthorization(authorization: PasswordWriteAuthorization): void {
  if (!authorization || !authorization.sessionId || authorization.sessionId.length > 1024 ||
    typeof authorization.verifiedEmail !== "string" || !authorization.verifiedEmail ||
    authorization.verifiedEmail !== authorization.verifiedEmail.trim().toLowerCase() ||
    !Number.isSafeInteger(authorization.generation) || authorization.generation < 0 ||
    !Number.isSafeInteger(authorization.now) || authorization.now < 0 ||
    (authorization.freshUntil !== undefined && (!Number.isSafeInteger(authorization.freshUntil) || authorization.freshUntil < 0))) {
    throw new TypeError("invalid password authorization");
  }
}

export function passwordCredential(credential: PasswordCredential): PasswordCredential {
  if (!credential.subject.startsWith("tsub_") || !credential.passwordHash ||
    !Number.isSafeInteger(credential.version) || credential.version < 1) {
    throw new TypeError("invalid password credential");
  }
  return { subject: credential.subject, passwordHash: credential.passwordHash, version: credential.version };
}

export function passwordReplacement(expected: number, credential: PasswordCredential, now: number): PasswordCredential {
  const next = passwordCredential(credential);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expected) ||
    expected < 1 || next.version !== expected + 1) {
    throw new TypeError("invalid password replacement");
  }
  return next;
}

export function assertPasswordAttempt(key: string, now: number, limit: number, windowMs: number): void {
  if (!key || key.length > 256 || !Number.isSafeInteger(now) || now < 0 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000 ||
    !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 86_400_000 ||
    !Number.isSafeInteger(now + windowMs)) {
    throw new TypeError("invalid password attempt");
  }
}

/** Pure reference adapter: all decisions, mutations and revocation hooks are synchronous after hashing. */
export class MemoryPasswordAuthStore implements PasswordAuthStore {
  readonly #credentials = new Map<TakosumiSubject, PasswordCredential>();
  readonly #attempts = new Map<string, { count: number; expiresAt: number }>();
  #sweep: Iterator<[string, { count: number; expiresAt: number }]> | undefined;

  constructor(
    readonly accounts: Map<TakosumiSubject, TakosumiAccountRecord>,
    readonly revoke: (subject: TakosumiSubject, now: number) => void,
    readonly authorize: (subject: TakosumiSubject, authorization: PasswordWriteAuthorization, fallbackAnchor: string) => boolean,
    readonly subjectIsActive: (subject: TakosumiSubject) => boolean = () => true,
    readonly canRevoke: (subject: TakosumiSubject) => boolean = () => true,
  ) {}

  async findBySubject(subject: TakosumiSubject): Promise<PasswordCredential | undefined> {
    return structuredClone(this.#credentials.get(subject));
  }

  private accountMatches(subject: TakosumiSubject, authorization: PasswordWriteAuthorization): boolean {
    const account = this.accounts.get(subject);
    if (authorization.freshUntil !== undefined && authorization.now > authorization.freshUntil) return false;
    if (account?.emailVerified !== true || account.email?.trim().toLowerCase() !== authorization.verifiedEmail) return false;
    for (const other of this.accounts.values()) {
      if (other.subject !== subject && other.emailVerified === true &&
        other.email?.trim().toLowerCase() === authorization.verifiedEmail) return false;
    }
    return true;
  }

  async create(credential: PasswordCredential, authorization: PasswordWriteAuthorization): Promise<boolean> {
    const next = passwordCredential(credential);
    assertPasswordAuthorization(authorization);
    const anchor = await hostedIssuerSessionId(authorization.sessionId);
    if (next.version !== 1 || !this.accountMatches(next.subject, authorization) || this.#credentials.has(next.subject) ||
      !this.subjectIsActive(next.subject) || !this.authorize(next.subject, authorization, anchor)) return false;
    this.#credentials.set(next.subject, next);
    return true;
  }

  async replace(expectedVersion: number, credential: PasswordCredential, now: number, authorization: PasswordWriteAuthorization): Promise<boolean> {
    const next = passwordReplacement(expectedVersion, credential, now);
    assertPasswordAuthorization(authorization);
    const anchor = await hostedIssuerSessionId(authorization.sessionId);
    const old = this.#credentials.get(next.subject);
    if (!old || old.version !== expectedVersion || !this.accountMatches(next.subject, authorization) ||
      !this.subjectIsActive(next.subject) || !this.authorize(next.subject, authorization, anchor) ||
      !this.canRevoke(next.subject)) return false;
    this.revoke(next.subject, now);
    this.#credentials.set(next.subject, next);
    return true;
  }

  async consumeAttempt(key: string, now: number, limit: number, windowMs: number): Promise<boolean> {
    assertPasswordAttempt(key, now, limit, windowMs);
    this.#sweep ??= this.#attempts.entries();
    for (let index = 0; index < PASSWORD_ATTEMPT_SWEEP_LIMIT; index++) {
      const item = this.#sweep.next();
      if (item.done) { this.#sweep = undefined; break; }
      if (item.value[1].expiresAt <= now) this.#attempts.delete(item.value[0]);
    }
    const old = this.#attempts.get(key);
    if (old && old.expiresAt > now) {
      if (old.count >= limit) return false;
      old.count++;
    } else this.#attempts.set(key, { count: 1, expiresAt: now + windowMs });
    return true;
  }
}
