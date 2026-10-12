import type {
  PrivateRunFilePointer,
  PrivateRunFilePointerLookup,
  PrivateRunFileReceipt,
  PrivateRunFileRepositoryPort,
  PrivateRunFileScope,
} from "../../core/domains/private-run-files/mod.ts";
import type { D1Database, D1Result } from "./bindings.ts";

type Authority = {
  readonly scope: PrivateRunFileScope;
  readonly runId: string;
  readonly executionAuthorityEpoch: number;
  readonly leaseToken: string;
};

type Commit = Parameters<PrivateRunFileRepositoryPort["commitPointer"]>[0];

interface PointerRow {
  readonly authorityOk: number;
  readonly version: number | null;
  readonly digest: string | null;
  readonly blobId: string | null;
}

interface ReceiptRow {
  readonly authorityOk?: number;
  readonly version: number | null;
  readonly digest: string | null;
  readonly blobId: string | null;
  readonly commitId: string | null;
  readonly expectedVersion: number | null;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

// Existing leased Runs may settle during the current drain. The original
// active admission tuple is persisted on the Run; neither the grant nor a
// caller-supplied epoch may replace it. Match the deploy-control store's
// original-epoch < draining-epoch settlement cutoff.
const DRAIN_SETTLEMENT_AUTHORITY = `case when json_valid(r.run_json) = 1
  and json_type(r.run_json, '$.workspaceManagementAuthority') = 'object'
  and json_type(r.run_json, '$.workspaceManagementAuthority.workspaceId') = 'text'
  and json_extract(r.run_json, '$.workspaceManagementAuthority.workspaceId') = w.id
  and json_type(r.run_json, '$.workspaceManagementAuthority.managementState') = 'text'
  and json_extract(r.run_json, '$.workspaceManagementAuthority.managementState') = 'active'
  and json_type(r.run_json, '$.workspaceManagementAuthority.managementEpoch') = 'integer'
  and json_extract(r.run_json, '$.workspaceManagementAuthority.managementEpoch') > 0
  and json_extract(r.run_json, '$.workspaceManagementAuthority.managementEpoch') <= 9007199254740991
  and json_extract(r.run_json, '$.workspaceManagementAuthority.managementEpoch') < w.management_epoch
  then 1 else 0 end`;

// A single SQLite statement sees one authority and pointer/receipt snapshot.
// Only Plan/Apply variants have a canonical captured Capsule epoch.
const CURRENT_AUTHORITY = `
  select 1 from workspaces w
  join capsules c on c.space_id = w.id
  join runs r on r.space_id = w.id and r.installation_id = c.id
  where w.id = ? and (w.management_state = 'active'
    or (w.management_state = 'draining'
      and typeof(w.management_epoch) = 'integer'
      and w.management_epoch > 0 and w.management_epoch <= 9007199254740991
      and ${DRAIN_SETTLEMENT_AUTHORITY} = 1))
    and c.id = ? and c.environment = ? and c.execution_authority_epoch = ?
    and r.id = ? and r.environment = c.environment
    and r.status = 'running' and r.lease_token = ?
    and r.type in ('plan', 'apply', 'destroy_plan', 'destroy_apply', 'drift_check')
    and case when json_valid(r.run_json) = 1 then
      json_extract(r.run_json, '$.id') = r.id
      and json_extract(r.run_json, '$.workspaceId') = w.id
      and json_extract(r.run_json, '$.capsuleId') = c.id
      and json_extract(r.run_json, '$.status') = r.status
      and (case when r.type in ('plan', 'destroy_plan', 'drift_check')
        then json_extract(r.run_json, '$.capsuleExecutionAuthorityEpoch')
        else json_extract(r.run_json, '$.expected.capsuleExecutionAuthorityEpoch')
      end) = ?
    else 0 end
`;

const READ_POINTER = `
  select exists(${CURRENT_AUTHORITY}) as authorityOk,
    p.version, p.digest, p.blob_id as blobId
  from (select 1) as one
  left join private_run_file_pointers p
    on p.workspace_id = ? and p.capsule_id = ? and p.environment = ? and p.slot = ?
`;

const READ_RECEIPT = `
  select exists(${CURRENT_AUTHORITY}) as authorityOk,
    r.commit_id as commitId, r.expected_version as expectedVersion,
    r.version, r.digest, r.blob_id as blobId
  from (select 1) as one
  left join private_run_file_receipts r
    on r.workspace_id = ? and r.capsule_id = ? and r.environment = ?
   and r.slot = ? and r.commit_id = ?
`;

// A selected invalid Run row violates runs.space_id NOT NULL (or its existing
// primary key) and aborts the entire D1 batch. Merely observing zero changed
// rows is not an atomic CAS+receipt fence.
const ABORT_RUN = `insert into runs
  (id, space_id, type, status, run_json, created_at)
  select ?, null, 'plan', 'running', '{}', '' where `;

const AUTHORITY_AND_REPLAY_GUARD = `${ABORT_RUN}
  not exists(${CURRENT_AUTHORITY})
  or exists(select 1 from private_run_file_receipts
    where workspace_id = ? and capsule_id = ? and environment = ?
      and slot = ? and commit_id = ?)
  or exists(select 1 from private_run_file_pointers
    where workspace_id = ? and capsule_id = ? and environment = ?
      and slot = ? and latest_commit_id = ?)`;

const POINTER_WIN_GUARD = `${ABORT_RUN}
  not exists(select 1 from private_run_file_pointers
    where workspace_id = ? and capsule_id = ? and environment = ? and slot = ?
      and version = ? and digest = ? and blob_id = ? and latest_commit_id = ?)`;

const RECEIPT_SELECT = `select workspace_id as workspaceId,
  capsule_id as capsuleId, environment, slot,
  commit_id as commitId, expected_version as expectedVersion,
  version, digest, blob_id as blobId
  from private_run_file_receipts
  where workspace_id = ? and capsule_id = ? and environment = ?
    and slot = ? and commit_id = ?`;

/** D1-specific authority-fenced private-file repository; no SQL callback shim. */
export class D1PrivateRunFileRepository
  implements PrivateRunFileRepositoryPort {
  constructor(private readonly db: D1Database) {}

  async readPointer(input: Authority): Promise<PrivateRunFilePointerLookup> {
    if (!validAuthority(input)) return { kind: "unknown" };
    try {
      const row = await this.db.prepare(READ_POINTER)
        .bind(...authorityParams(input), ...scopeParams(input.scope))
        .first<PointerRow>();
      if (!row || row.authorityOk !== 1 && row.authorityOk !== 0) {
        return { kind: "unknown" };
      }
      if (row.authorityOk === 0) return { kind: "authority_rejected" };
      if (row.version === null) return { kind: "absent" };
      return { kind: "present", pointer: parsePointer(row) };
    } catch {
      return { kind: "unknown" };
    }
  }

  async lookupReceipt(
    input: Authority & { readonly commitId: string },
  ): Promise<
    | { readonly kind: "found"; readonly receipt: PrivateRunFileReceipt }
    | { readonly kind: "absent" | "authority_rejected" | "unknown" }
  > {
    if (!validAuthority(input) || !validText(input.commitId)) {
      return { kind: "unknown" };
    }
    try {
      const row = await this.db.prepare(READ_RECEIPT)
        .bind(
          ...authorityParams(input),
          ...scopeParams(input.scope),
          input.commitId,
        )
        .first<ReceiptRow>();
      if (!row || row.authorityOk !== 1 && row.authorityOk !== 0) {
        return { kind: "unknown" };
      }
      if (row.authorityOk === 0) return { kind: "authority_rejected" };
      if (row.commitId === null) return { kind: "absent" };
      return { kind: "found", receipt: parseReceipt(row, input.scope) };
    } catch {
      return { kind: "unknown" };
    }
  }

  async commitPointer(
    input: Commit,
  ): ReturnType<PrivateRunFileRepositoryPort["commitPointer"]> {
    if (
      !validAuthority(input) || !validText(input.commitId) ||
      !validText(input.blobId) || !DIGEST.test(input.digest) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      input.expectedVersion >= Number.MAX_SAFE_INTEGER
    ) {
      return { kind: "unknown" };
    }
    const prior = await this.lookupReceipt(input);
    if (prior.kind === "authority_rejected") {
      return { kind: "authority_rejected" };
    }
    if (prior.kind === "unknown") return { kind: "unknown" };
    if (prior.kind === "found") {
      return sameReceipt(prior.receipt, input)
        ? { kind: "replayed", receipt: prior.receipt }
        : { kind: "conflict" };
    }

    const scope = scopeParams(input.scope);
    const nextVersion = input.expectedVersion + 1;
    const mutation = input.expectedVersion === 0
      ? this.db.prepare(`insert into private_run_file_pointers
          (workspace_id, capsule_id, environment, slot, version, digest, blob_id, latest_commit_id)
          values (?, ?, ?, ?, 1, ?, ?, ?)
          on conflict (workspace_id, capsule_id, environment, slot) do nothing`)
        .bind(...scope, input.digest, input.blobId, input.commitId)
      : this.db.prepare(`update private_run_file_pointers
          set version = ?, digest = ?, blob_id = ?, latest_commit_id = ?
          where workspace_id = ? and capsule_id = ? and environment = ?
            and slot = ? and version = ?`)
        .bind(
          nextVersion,
          input.digest,
          input.blobId,
          input.commitId,
          ...scope,
          input.expectedVersion,
        );
    const statements = [
      this.db.prepare(AUTHORITY_AND_REPLAY_GUARD).bind(
        input.runId,
        ...authorityParams(input),
        ...scope,
        input.commitId,
        ...scope,
        input.commitId,
      ),
      mutation,
      this.db.prepare(POINTER_WIN_GUARD).bind(
        input.runId,
        ...scope,
        nextVersion,
        input.digest,
        input.blobId,
        input.commitId,
      ),
      this.db.prepare(`insert into private_run_file_receipts
        (workspace_id, capsule_id, environment, slot, commit_id,
         expected_version, version, digest, blob_id)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        ...scope,
        input.commitId,
        input.expectedVersion,
        nextVersion,
        input.digest,
        input.blobId,
      ),
      this.db.prepare(RECEIPT_SELECT).bind(...scope, input.commitId),
    ];
    try {
      const results = await this.db.batch<ReceiptRow>(statements);
      if (
        results.length !== statements.length ||
        results.some((result: D1Result<ReceiptRow>) => result.success === false)
      ) {
        return { kind: "unknown" };
      }
      const row = results.at(-1)?.results?.[0];
      if (!row) return { kind: "unknown" };
      const receipt = parseReceipt(row, input.scope);
      return sameReceipt(receipt, input) && receipt.blobId === input.blobId
        ? { kind: "committed", receipt }
        : { kind: "unknown" };
    } catch {
      // A transport error may follow a durable commit. Never reissue mutation.
      const resolved = await this.lookupReceipt(input);
      if (resolved.kind === "authority_rejected") {
        return { kind: "authority_rejected" };
      }
      if (resolved.kind === "found") {
        return sameReceipt(resolved.receipt, input)
          ? { kind: "replayed", receipt: resolved.receipt }
          : { kind: "conflict" };
      }
      return { kind: "unknown" };
    }
  }
}

function authorityParams(input: Authority) {
  return [
    input.scope.workspaceId,
    input.scope.capsuleId,
    input.scope.environment,
    input.executionAuthorityEpoch,
    input.runId,
    input.leaseToken,
    input.executionAuthorityEpoch,
  ] as const;
}

function scopeParams(scope: PrivateRunFileScope) {
  return [
    scope.workspaceId,
    scope.capsuleId,
    scope.environment,
    scope.slot,
  ] as const;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    !value.includes("\0");
}

function validAuthority(input: Authority): boolean {
  return !!input && !!input.scope &&
    [
      input.scope.workspaceId,
      input.scope.capsuleId,
      input.scope.environment,
      input.scope.slot,
      input.runId,
      input.leaseToken,
    ].every(validText) &&
    Number.isSafeInteger(input.executionAuthorityEpoch) &&
    input.executionAuthorityEpoch >= 1;
}

function parsePointer(
  row: Pick<PointerRow, "version" | "digest" | "blobId">,
): PrivateRunFilePointer {
  if (
    !Number.isSafeInteger(row.version) || row.version! < 1 ||
    typeof row.digest !== "string" || !DIGEST.test(row.digest) ||
    !validText(row.blobId)
  ) throw new Error("invalid private file pointer");
  return {
    version: row.version!,
    digest: row.digest as `sha256:${string}`,
    blobId: row.blobId,
  };
}

function parseReceipt(
  row: ReceiptRow,
  scope: PrivateRunFileScope,
): PrivateRunFileReceipt {
  const pointer = parsePointer(row);
  if (
    !validText(row.commitId) || !Number.isSafeInteger(row.expectedVersion) ||
    row.expectedVersion! < 0 || pointer.version !== row.expectedVersion! + 1
  ) {
    throw new Error("invalid private file receipt");
  }
  return {
    scope: { ...scope },
    commitId: row.commitId,
    expectedVersion: row.expectedVersion!,
    ...pointer,
  };
}

function sameReceipt(receipt: PrivateRunFileReceipt, input: Commit): boolean {
  return receipt.scope.workspaceId === input.scope.workspaceId &&
    receipt.scope.capsuleId === input.scope.capsuleId &&
    receipt.scope.environment === input.scope.environment &&
    receipt.scope.slot === input.scope.slot &&
    receipt.commitId === input.commitId &&
    receipt.expectedVersion === input.expectedVersion &&
    receipt.version === input.expectedVersion + 1 &&
    receipt.digest === input.digest;
}
