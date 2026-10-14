import type {
  CredentialUnlinkIntent,
  CredentialUnlinkReceipt,
  CredentialUnlinkMutation,
} from "./identity-unlink-state.ts";
import type { IdentityMergeRetryCheckpointMutation } from "./identity-state.ts";
import { hashSessionId } from "./session-hash-salt.ts";
import type { IdentityRecordRepository } from "./hosted-identity-records.ts";
import {
  assertMergeMutation,
  identityMergeProofAudit,
  assertCredentialUnlinkMutation,
  unlinkImmutableContext,
  credentialUnlinkAudit,
  identityRecordsEqual,
} from "./hosted-identity-records.ts";
import type {
  AccountSessionRecord,
  TakosumiAccountRecord,
  UpstreamIdentityRecord,
} from "./store.ts";
import type {
  IdentityOperationReceiptRecord,
  IdentityMergeMutation,
  IdentityMergeOperation,
  UnlinkUpstreamIdentityInput,
} from "./identity-state.ts";
import { upstreamIdentityKey } from "./identity-state.ts";

export class MemoryIdentityRecordRepository
  implements IdentityRecordRepository
{
  readonly records = new Map<string, unknown>();
  constructor(
    readonly accounts: Map<string, TakosumiAccountRecord>,
    readonly sessions: Map<string, AccountSessionRecord>,
    readonly identities: Map<string, UpstreamIdentityRecord>,
    readonly revoke: (subjects: readonly string[], now: number) => void,
  ) {}
  private assertReferences(record: unknown): void {
    const r = record as Record<string, unknown>;
    for (const subject of [
      r.subject ?? r.targetSubject ?? r.canonicalSubject,
      r.sourceSubject,
    ])
      if (typeof subject === "string" && !this.accounts.has(subject))
        throw new Error("identity_record_subject_missing");
  }
  private key(bucket: string, key: string): string {
    return `${bucket}\n${key}`;
  }
  async get<T>(bucket: string, key: string): Promise<T | undefined> {
    const r = this.records.get(this.key(bucket, key));
    return r === undefined ? undefined : (structuredClone(r) as T);
  }
  async put(bucket: string, key: string, record: unknown): Promise<void> {
    this.assertReferences(record);
    this.records.set(this.key(bucket, key), structuredClone(record));
  }
  async create(bucket: string, key: string, record: unknown): Promise<boolean> {
    this.assertReferences(record);
    const k = this.key(bucket, key);
    if (this.records.has(k)) return false;
    this.records.set(k, structuredClone(record));
    return true;
  }
  async consume<T>(
    bucket: string,
    key: string,
    binding: string,
    now: number,
  ): Promise<T | undefined> {
    const k = this.key(bucket, key);
    const r = this.records.get(k) as
      | { browserBindingHash: string; expiresAt: number }
      | undefined;
    if (!r || r.browserBindingHash !== binding || r.expiresAt <= now)
      return undefined;
    this.records.delete(k);
    return structuredClone(r) as T;
  }
  async query<T>(
    bucket: string,
    field: string,
    value: string,
    limit: number,
  ): Promise<readonly T[]> {
    return [...this.records]
      .filter(
        ([k, v]) =>
          k.startsWith(`${bucket}\n`) &&
          (v as Record<string, unknown>)[field] === value,
      )
      .slice(0, limit)
      .map(([, v]) => structuredClone(v) as T);
  }
  async revokeGrants(
    field: "issuerSessionId" | "clientId" | "sid",
    value: string,
    now: number,
  ): Promise<void> {
    for (const [k, v] of this.records) {
      const r = v as Record<string, unknown>;
      if (
        k.startsWith("hosted_oidc_grants\n") &&
        r[field] === value &&
        r.revokedAt === undefined
      )
        this.records.set(k, { ...r, revokedAt: now });
    }
  }
  async emailCandidates(
    address: string,
  ): Promise<readonly TakosumiAccountRecord[]> {
    return [...this.accounts.values()]
      .filter((a) => candidateMatches(a.email, address))
      .slice(0, 3)
      .map((a) => ({ ...a }));
  }
  async listIdentities(
    subject: string,
  ): Promise<readonly UpstreamIdentityRecord[]> {
    return [...this.identities.values()]
      .filter(
        (i) =>
          ((
            this.records.get(this.key("canonical_accounts", i.subject)) as
              | { targetSubject: string }
              | undefined
          )?.targetSubject ?? i.subject) === subject &&
          !(
            this.records.get(
              this.key("upstream_identity_status", upstreamIdentityKey(i)),
            ) as { disabledAt?: number } | undefined
          )?.disabledAt,
      )
      .slice(0, 101)
      .map((i) => ({ ...i }));
  }
  async touchSession(
    sessionId: string,
    now: number,
    idleExpiresAt: number,
  ): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (
      !s ||
      s.policy !== "hosted" ||
      s.expiresAt <= now ||
      !s.absoluteExpiresAt ||
      s.absoluteExpiresAt <= now
    )
      return false;
    this.sessions.set(sessionId, {
      ...s,
      expiresAt: Math.min(idleExpiresAt, s.absoluteExpiresAt),
    });
    return true;
  }
  async mutateMerge(input: IdentityMergeMutation): Promise<boolean> {
    assertMergeMutation(input);
    const lookup = new Map<string, string>();
    for (const key of this.sessions.keys())
      lookup.set(await hashSessionId(key), key);
    const n = input.next;
    const old = this.records.get(
      this.key("identity_merge_operations", n.operationId),
    ) as IdentityMergeOperation | undefined;
    if (
      !old ||
      old.revision !== input.expectedRevision ||
      old.sourceSubject !== n.sourceSubject ||
      old.targetSubject !== n.targetSubject
    )
      return false;
    if (
      !input.quarantine &&
      !input.restore &&
      !input.abort &&
      !input.requireRecovery &&
      (old.expiresAt <= input.now ||
        this.records.has(this.key("canonical_accounts", n.sourceSubject)) ||
        this.records.has(this.key("canonical_accounts", n.targetSubject)))
    )
      return false;
    if (
      input.restore &&
      (old.status !== "quarantined" ||
        (
          this.records.get(this.key("canonical_accounts", n.sourceSubject)) as
            | { operationId: string; targetSubject: string }
            | undefined
        )?.operationId !== n.operationId)
    )
      return false;
    if (
      input.abort &&
      (!old.consentAt ||
        !["proved", "reconciled", "quarantined"].includes(old.status) ||
        [n.sourceSubject, n.targetSubject].some(
          (subject) =>
            this.records.has(this.key("canonical_accounts", subject)) ||
            (
              this.records.get(this.key("identity_merge_locks", subject)) as
                | { operationId: string }
                | undefined
            )?.operationId !== n.operationId,
        ))
    )
      return false;
    if (
      input.requireRecovery &&
      (!old.consentAt ||
        !["proved", "reconciled"].includes(old.status) ||
        old.status !== n.status ||
        !this.hasExpiredEvidence(old, input.now))
    )
      return false;
    for (const p of input.sessions ?? []) {
      const s = this.sessions.get(
        p.sessionId ?? lookup.get(p.sessionLookupHash!)!,
      );
      if (
        !s ||
        s.subject !== p.subject ||
        (p.reauthentication === false ? s.authTime : s.reauthenticatedAt) !==
          p.authTime ||
        s.policy !== "hosted" ||
        s.expiresAt <= input.now ||
        !s.absoluteExpiresAt ||
        s.absoluteExpiresAt <= input.now ||
        (s.identityGeneration ?? 0) !==
          ((
            this.records.get(
              this.key("authentication_generations", s.subject),
            ) as { generation: number } | undefined
          )?.generation ?? 0)
      )
        return false;
    }
    for (const proof of input.emailProofs ?? []) {
      const saved = this.records.get(
        this.key("account_email_proofs", proof.subject),
      );
      const account = this.accounts.get(proof.subject);
      if (
        JSON.stringify(saved) !== JSON.stringify(proof) ||
        account?.email !== proof.address ||
        account.emailVerified !== true
      )
        return false;
    }
    if (
      input.emailProofs?.length &&
      [...this.accounts.values()].filter((a) =>
        candidateMatches(a.email, input.emailProofs![0]!.normalizedAddress),
      ).length !== 2
    )
      return false;
    if (
      input.receipt &&
      !this.validReceipt(input.receipt, n, input.now, false, 0)
    )
      return false;
    for (const receipt of input.proofReceipts ?? [])
      if (
        !this.validReceipt(
          receipt,
          n,
          input.now,
          true,
          input.activate || n.status === "reconciled" ? 1 : 0,
        )
      )
        return false;
    if (
      input.activate &&
      (old.status !== "reconciled" ||
        [n.sourceSubject, n.targetSubject].some(
          (subject) =>
            (
              this.records.get(this.key("identity_merge_locks", subject)) as
                | { operationId: string }
                | undefined
            )?.operationId !== n.operationId,
        ))
    )
      return false;
    if (input.reserve || input.activate) {
      for (const subject of [n.sourceSubject, n.targetSubject]) {
        const l = this.records.get(
          this.key("identity_merge_locks", subject),
        ) as { operationId: string } | undefined;
        if (l && l.operationId !== n.operationId) return false;
      }
    }
    if (
      input.reserve &&
      [...this.records.keys()]
        .filter((k) => k.startsWith("identity_merge_retry_pending\n"))
        .slice(0, input.retryCapacity!).length >= input.retryCapacity!
    )
      return false;
    // No awaits in this decision/write section: one winner consumes the proof.
    this.records.set(
      this.key("identity_merge_operations", n.operationId),
      structuredClone(n),
    );
    this.records.set(
      this.key("identity_merge_audit", `${n.operationId}:${n.revision}`),
      {
        operationId: n.operationId,
        sourceSubject: n.sourceSubject,
        targetSubject: n.targetSubject,
        actor: n.actor,
        policyVersion: n.policyVersion,
        decision: n.status,
        proofs: identityMergeProofAudit(n),
        consentAt: n.consentAt,
        acknowledgements: n.acknowledgements,
        undoOperationId: n.undoOperationId,
        recoveryAcknowledgements: n.recoveryAcknowledgements,
        at: input.now,
      },
    );
    if (input.receipt)
      this.records.set(
        this.key("identity_operation_receipts", input.receipt.receiptId),
        {
          ...input.receipt,
          consumedByOperation: n.operationId,
          consumedAt: input.now,
        },
      );
    if (input.reserve || input.quarantine || input.restore) {
      for (const subject of [n.sourceSubject, n.targetSubject])
        this.records.set(this.key("identity_merge_locks", subject), {
          operationId: n.operationId,
          subject,
        });
      this.revokeSubjects([n.sourceSubject, n.targetSubject], input.now);
    }
    if (input.restore || input.abort) {
      if (input.restore)
        this.records.delete(this.key("canonical_accounts", n.sourceSubject));
      for (const subject of [n.sourceSubject, n.targetSubject])
        this.records.delete(this.key("identity_merge_locks", subject));
    }
    if (input.activate || input.abort)
      this.revokeSubjects([n.sourceSubject, n.targetSubject], input.now);
    if (
      input.reserve ||
      input.activate ||
      input.quarantine ||
      input.restore ||
      input.abort
    )
      this.advanceGeneration([n.sourceSubject, n.targetSubject]);
    if (input.reserve)
      this.records.set(
        this.key("identity_merge_retry_pending", n.operationId),
        { operationId: n.operationId },
      );
    if (input.activate || input.requireRecovery || input.abort || input.restore)
      this.records.delete(
        this.key("identity_merge_retry_pending", n.operationId),
      );
    if (input.activate)
      this.records.set(this.key("canonical_accounts", n.sourceSubject), {
        sourceSubject: n.sourceSubject,
        targetSubject: n.targetSubject,
        operationId: n.operationId,
        activatedAt: input.now,
      });
    return true;
  }
  private hasExpiredEvidence(op: IdentityMergeOperation, now: number): boolean {
    return (
      op.expiresAt <= now ||
      [op.sourceProof, op.targetProof].some(
        (p) =>
          !p ||
          (
            this.records.get(
              this.key("identity_operation_receipts", p.receiptId),
            ) as IdentityOperationReceiptRecord | undefined
          )?.expiresAt! <= now,
      ) ||
      [op.sourceSubject, op.targetSubject].some(
        (subject) =>
          (
            this.records.get(this.key("account_email_proofs", subject)) as
              | { validUntil: number }
              | undefined
          )?.validUntil! <= now,
      )
    );
  }
  private validReceipt(
    r: IdentityOperationReceiptRecord,
    op: IdentityMergeOperation,
    now: number,
    consumed: boolean,
    offset: number,
  ): boolean {
    const stored = this.records.get(
      this.key("identity_operation_receipts", r.receiptId),
    );
    const subject = r.role === "source" ? op.sourceSubject : op.targetSubject;
    const identity = [...this.identities.values()].find(
      (i) =>
        i.providerId === r.providerId &&
        i.upstreamIssuer === r.upstreamIssuer &&
        i.upstreamSubject === r.upstreamSubject,
    );
    return (
      JSON.stringify(stored) === JSON.stringify(r) &&
      r.operationId === op.operationId &&
      r.sourceSubject === op.sourceSubject &&
      r.targetSubject === op.targetSubject &&
      r.subject === subject &&
      r.browserBindingHash === op.browserBindingHash &&
      r.policyVersion === op.policyVersion &&
      r.emailDigest === op.addressDigest &&
      r.startedAt >= op.createdAt &&
      r.completedAt >= r.startedAt &&
      r.completedAt <= now &&
      r.legConsent === true &&
      r.legConsentAt >= r.startedAt &&
      r.legConsentAt <= r.completedAt &&
      r.expiresAt > now &&
      r.expiresAt <= r.startedAt + 300000 &&
      r.identityGeneration + offset ===
        ((
          this.records.get(this.key("authentication_generations", subject)) as
            | { generation: number }
            | undefined
        )?.generation ?? 0) &&
      (consumed
        ? r.consumedByOperation === op.operationId
        : r.consumedByOperation === undefined) &&
      !this.records.has(
        this.key("hosted_oidc_revoked_sessions", r.issuerSessionHash),
      ) &&
      identity?.subject === subject &&
      !(
        this.records.get(
          this.key("upstream_identity_status", upstreamIdentityKey(r)),
        ) as { disabledAt?: number } | undefined
      )?.disabledAt
    );
  }
  private advanceGeneration(subjects: readonly string[]): void {
    for (const subject of new Set(subjects)) {
      const old = this.records.get(
        this.key("authentication_generations", subject),
      ) as { generation: number } | undefined;
      this.records.set(this.key("authentication_generations", subject), {
        subject,
        generation: (old?.generation ?? 0) + 1,
      });
    }
  }
  private revokeSubjects(subjects: readonly string[], now: number): void {
    this.revoke(subjects, now);
    for (const [k, v] of this.records) {
      const r = v as Record<string, unknown>;
      if (
        k.startsWith("hosted_oidc_grants\n") &&
        subjects.includes(r.subject as string)
      )
        this.records.set(k, { ...r, revokedAt: now });
    }
  }

  async page<T>(
    bucket: string,
    after: string | undefined,
    limit: number,
  ): Promise<readonly { key: string; record: T }[]> {
    return [...this.records]
      .filter(
        ([k]) =>
          k.startsWith(`${bucket}\n`) &&
          (!after || k.slice(bucket.length + 1) > after),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([k, v]) => ({
        key: k.slice(bucket.length + 1),
        record: structuredClone(v) as T,
      }));
  }
  async compareAndSetCheckpoint(
    input: IdentityMergeRetryCheckpointMutation,
  ): Promise<boolean> {
    const key = this.key("identity_merge_retry_checkpoints", input.key);
    const old = this.records.get(key) as { revision: number } | undefined;
    if (
      input.expectedRevision === undefined
        ? old !== undefined
        : old?.revision !== input.expectedRevision
    )
      return false;
    this.records.set(key, structuredClone(input.next));
    return true;
  }
  async completeUnlink(input: CredentialUnlinkMutation): Promise<boolean> {
    try {
      assertCredentialUnlinkMutation(input);
    } catch {
      return false;
    }
    const { next: n, receipt: r } = input;
    const key = this.key("credential_unlink_intents", n.operationId);
    const old = this.records.get(key) as CredentialUnlinkIntent | undefined;
    if (old?.status === "completed") return identityRecordsEqual(old, n);
    if (
      !old ||
      old.status !== "pending" ||
      old.revision !== input.expectedRevision ||
      !identityRecordsEqual(
        unlinkImmutableContext(old),
        unlinkImmutableContext(n),
      ) ||
      JSON.stringify(
        this.records.get(this.key("credential_unlink_receipts", r.receiptId)),
      ) !== JSON.stringify(r) ||
      this.records.has(
        this.key("hosted_oidc_revoked_sessions", n.issuerSessionHash),
      ) ||
      ((
        this.records.get(this.key("authentication_generations", n.subject)) as
          | { generation: number }
          | undefined
      )?.generation ?? 0) !== n.identityGeneration ||
      this.records.has(this.key("canonical_accounts", n.subject))
    )
      return false;
    const lock = this.records.get(
      this.key("identity_merge_locks", n.subject),
    ) as { operationId: string } | undefined;
    if (
      lock &&
      (
        this.records.get(
          this.key("identity_merge_operations", lock.operationId),
        ) as IdentityMergeOperation | undefined
      )?.status !== "active"
    )
      return false;
    for (const tuple of [n.removedIdentity, n.retainedIdentity]) {
      const identity = [...this.identities.values()].find(
        (i) => upstreamIdentityKey(i) === upstreamIdentityKey(tuple),
      );
      if (
        !identity ||
        ((
          this.records.get(this.key("canonical_accounts", identity.subject)) as
            | { targetSubject: string }
            | undefined
        )?.targetSubject ?? identity.subject) !== n.subject ||
        (
          this.records.get(
            this.key("upstream_identity_status", upstreamIdentityKey(tuple)),
          ) as { disabledAt?: number } | undefined
        )?.disabledAt !== undefined
      )
        return false;
    }
    this.records.set(key, structuredClone(n));
    this.records.set(this.key("credential_unlink_receipts", r.receiptId), {
      ...r,
      consumedByOperation: n.operationId,
    });
    this.records.set(
      this.key(
        "upstream_identity_status",
        upstreamIdentityKey(n.removedIdentity),
      ),
      {
        ...n.removedIdentity,
        identityKey: upstreamIdentityKey(n.removedIdentity),
        canonicalSubject: n.subject,
        disabledAt: input.now,
        operationId: n.operationId,
      },
    );
    this.records.set(
      this.key("identity_merge_audit", n.operationId),
      credentialUnlinkAudit(input),
    );
    this.advanceGeneration([n.subject]);
    this.revokeSubjects([n.subject], input.now);
    return true;
  }
  async unlink(input: UnlinkUpstreamIdentityInput): Promise<boolean> {
    const lookup = new Map<string, string>();
    for (const key of this.sessions.keys())
      lookup.set(await hashSessionId(key), key);
    const s = this.sessions.get(
      input.proof.sessionId ?? lookup.get(input.proof.sessionLookupHash!)!,
    );
    if (
      !s ||
      s.subject !== input.subject ||
      s.reauthenticatedAt !== input.proof.authTime ||
      s.policy !== "hosted" ||
      s.expiresAt <= input.now ||
      !s.absoluteExpiresAt ||
      s.absoluteExpiresAt <= input.now ||
      (s.identityGeneration ?? 0) !==
        ((
          this.records.get(
            this.key("authentication_generations", s.subject),
          ) as { generation: number } | undefined
        )?.generation ?? 0)
    )
      return false;
    const identityKey = upstreamIdentityKey(input.identity);
    if (this.records.has(this.key("upstream_identity_status", identityKey)))
      return false;
    const canonical = (subject: string) =>
      (
        this.records.get(this.key("canonical_accounts", subject)) as
          | { targetSubject: string }
          | undefined
      )?.targetSubject ?? subject;
    const entries = [...this.identities.values()].filter(
      (i) =>
        canonical(i.subject) === input.subject &&
        !this.records.has(
          this.key("upstream_identity_status", upstreamIdentityKey(i)),
        ),
    );
    if (
      entries.length < 2 ||
      !entries.some((i) => upstreamIdentityKey(i) === identityKey)
    )
      return false;
    const lock = this.records.get(
      this.key("identity_merge_locks", input.subject),
    ) as { operationId: string } | undefined;
    if (lock) {
      const op = this.records.get(
        this.key("identity_merge_operations", lock.operationId),
      ) as IdentityMergeOperation | undefined;
      if (op?.status !== "active") return false;
    }
    this.records.set(this.key("upstream_identity_status", identityKey), {
      identityKey,
      ...input.identity,
      canonicalSubject: input.subject,
      disabledAt: input.now,
      operationId: input.operationId,
    });
    this.records.set(this.key("identity_merge_audit", input.operationId), {
      operationId: input.operationId,
      subject: input.subject,
      decision: "credential_unlinked",
      identityKey,
      at: input.now,
    });
    this.revokeSubjects([input.subject], input.now);
    this.advanceGeneration([input.subject]);
    return true;
  }
}

function candidateMatches(email: string | undefined, address: string): boolean {
  if (!email) return false;
  const raw = email.trim();
  if (raw.toLowerCase() === address.trim().toLowerCase()) return true;
  const at = raw.lastIndexOf("@");
  return (
    at > 0 &&
    raw.slice(0, at).toLowerCase() ===
      address.slice(0, address.lastIndexOf("@")).toLowerCase() &&
    /[^\x00-\x7f]/.test(raw.slice(at + 1))
  );
}
