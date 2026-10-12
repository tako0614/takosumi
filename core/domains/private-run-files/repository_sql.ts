import type {
  PrivateRunFilePointer,
  PrivateRunFilePointerLookup,
  PrivateRunFileReceipt,
  PrivateRunFileRepositoryPort,
  PrivateRunFileScope,
} from "./mod.ts";
import type { SqlClient, SqlTransaction } from "../../adapters/storage/sql.ts";

interface PointerRow extends Record<string, unknown> {
  readonly version: number | string;
  readonly digest: string;
  readonly blobId: string;
}

interface ReceiptRow extends PointerRow {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly slot: string;
  readonly commitId: string;
  readonly expectedVersion: number | string;
}

interface LockedWorkspace extends Record<string, unknown> {
  readonly managementState: string;
}

interface LockedCapsule extends Record<string, unknown> {
  readonly workspaceId: string;
  readonly environment: string;
  readonly executionAuthorityEpoch: number | string;
}

interface LockedRun extends Record<string, unknown> {
  readonly workspaceId: string;
  readonly capsuleId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly leaseToken: string | null;
  readonly runJson: unknown;
}

type FenceResult = "accepted" | "rejected";

const knownRunKinds = new Set([
  "plan",
  "apply",
  "destroy_plan",
  "destroy_apply",
  "drift_check",
  "backup",
  "restore",
  "state_recovery",
]);

/** PostgreSQL repository for opaque private Run files. */
export class PostgresPrivateRunFileRepository implements PrivateRunFileRepositoryPort {
  readonly #client: SqlClient;

  constructor(client: SqlClient) {
    this.#client = client;
  }

  async readPointer(input: {
    readonly scope: PrivateRunFileScope;
    readonly runId: string;
    readonly executionAuthorityEpoch: number;
    readonly leaseToken: string;
  }): Promise<PrivateRunFilePointerLookup> {
    try {
      return await this.#client.transaction(async (transaction) => {
        const fence = await lockCurrentAuthority(transaction, input);
        if (fence !== "accepted") {
          return { kind: "authority_rejected" } as const;
        }
        const result = await transaction.query<PointerRow>(
          `select version, digest, blob_id as "blobId"
             from takosumi_private_run_file_pointers
            where workspace_id = $1 and capsule_id = $2 and environment = $3 and slot = $4`,
          scopeParameters(input.scope),
        );
        const row = result.rows[0];
        return row === undefined
          ? ({ kind: "absent" } as const)
          : ({ kind: "present", pointer: parsePointer(row) } as const);
      });
    } catch {
      return { kind: "unknown" };
    }
  }

  async lookupReceipt(input: {
    readonly scope: PrivateRunFileScope;
    readonly runId: string;
    readonly executionAuthorityEpoch: number;
    readonly leaseToken: string;
    readonly commitId: string;
  }): Promise<
    | { readonly kind: "found"; readonly receipt: PrivateRunFileReceipt }
    | { readonly kind: "absent" | "authority_rejected" | "unknown" }
  > {
    try {
      return await this.#client.transaction(async (transaction) => {
        const fence = await lockCurrentAuthority(transaction, input);
        if (fence !== "accepted") {
          return { kind: "authority_rejected" } as const;
        }
        const result = await transaction.query<ReceiptRow>(
          `select workspace_id as "workspaceId",
                  capsule_id as "capsuleId",
                  environment,
                  slot,
                  commit_id as "commitId",
                  expected_version as "expectedVersion",
                  version,
                  digest,
                  blob_id as "blobId"
             from takosumi_private_run_file_receipts
            where workspace_id = $1 and capsule_id = $2 and environment = $3
              and slot = $4 and commit_id = $5`,
          [...scopeParameters(input.scope), input.commitId],
        );
        const row = result.rows[0];
        return row === undefined
          ? ({ kind: "absent" } as const)
          : ({ kind: "found", receipt: parseReceipt(row) } as const);
      });
    } catch {
      return { kind: "unknown" };
    }
  }

  async commitPointer(input: {
    readonly scope: PrivateRunFileScope;
    readonly runId: string;
    readonly executionAuthorityEpoch: number;
    readonly leaseToken: string;
    readonly expectedVersion: number;
    readonly commitId: string;
    readonly digest: `sha256:${string}`;
    readonly blobId: string;
  }): Promise<
    | {
        readonly kind: "committed" | "replayed";
        readonly receipt: PrivateRunFileReceipt;
      }
    | { readonly kind: "conflict" | "authority_rejected" | "unknown" }
  > {
    try {
      return await this.#client.transaction(async (transaction) => {
        const fence = await lockCurrentAuthority(transaction, input);
        if (fence !== "accepted") {
          return { kind: "authority_rejected" } as const;
        }

        const receiptResult = await transaction.query<ReceiptRow>(
          `select workspace_id as "workspaceId",
                  capsule_id as "capsuleId",
                  environment,
                  slot,
                  commit_id as "commitId",
                  expected_version as "expectedVersion",
                  version,
                  digest,
                  blob_id as "blobId"
             from takosumi_private_run_file_receipts
            where workspace_id = $1 and capsule_id = $2 and environment = $3
              and slot = $4 and commit_id = $5`,
          [...scopeParameters(input.scope), input.commitId],
        );
        const prior = receiptResult.rows[0];
        if (prior !== undefined) {
          const receipt = parseReceipt(prior);
          if (!sameReceipt(receipt, input)) {
            return { kind: "conflict" } as const;
          }
          return { kind: "replayed", receipt } as const;
        }

        const pointerResult = await transaction.query<PointerRow>(
          `select version, digest, blob_id as "blobId"
             from takosumi_private_run_file_pointers
            where workspace_id = $1 and capsule_id = $2 and environment = $3 and slot = $4
            for update`,
          scopeParameters(input.scope),
        );
        const current = pointerResult.rows[0];
        if (input.expectedVersion === 0) {
          if (current !== undefined) return { kind: "conflict" } as const;
          const inserted = await transaction.query<PointerRow>(
            `insert into takosumi_private_run_file_pointers
               (workspace_id, capsule_id, environment, slot, version, digest, blob_id)
             values ($1, $2, $3, $4, 1, $5, $6)
             on conflict (workspace_id, capsule_id, environment, slot) do nothing
             returning version, digest, blob_id as "blobId"`,
            [...scopeParameters(input.scope), input.digest, input.blobId],
          );
          if (inserted.rowCount !== 1) return { kind: "conflict" } as const;
        } else {
          if (
            current === undefined ||
            parseVersion(current.version) !== input.expectedVersion
          ) {
            return { kind: "conflict" } as const;
          }
          const updated = await transaction.query<PointerRow>(
            `update takosumi_private_run_file_pointers
                set version = $1, digest = $2, blob_id = $3
              where workspace_id = $4 and capsule_id = $5 and environment = $6 and slot = $7
                and version = $8
              returning version, digest, blob_id as "blobId"`,
            [
              input.expectedVersion + 1,
              input.digest,
              input.blobId,
              ...scopeParameters(input.scope),
              input.expectedVersion,
            ],
          );
          if (updated.rowCount !== 1) return { kind: "conflict" } as const;
        }

        const insertedReceipt = await transaction.query<ReceiptRow>(
          `insert into takosumi_private_run_file_receipts
             (workspace_id, capsule_id, environment, slot, commit_id, expected_version, version, digest, blob_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (workspace_id, capsule_id, environment, slot, commit_id) do nothing
           returning workspace_id as "workspaceId",
                     capsule_id as "capsuleId",
                     environment,
                     slot,
                     commit_id as "commitId",
                     expected_version as "expectedVersion",
                     version,
                     digest,
                     blob_id as "blobId"`,
          [
            ...scopeParameters(input.scope),
            input.commitId,
            input.expectedVersion,
            input.expectedVersion + 1,
            input.digest,
            input.blobId,
          ],
        );
        if (insertedReceipt.rowCount !== 1) {
          // Pointer and receipt are one transaction; returning conflict causes
          // the adapter transaction wrapper to commit, so force rollback here.
          throw new Error("private run file receipt conflict");
        }
        return {
          kind: "committed",
          receipt: parseReceipt(insertedReceipt.rows[0]!),
        } as const;
      });
    } catch {
      // This includes an uncertain commit acknowledgement. Callers must use
      // explicit, authority-fenced lookupReceipt; this adapter never retries.
      return { kind: "unknown" };
    }
  }
}

async function lockCurrentAuthority(
  transaction: SqlTransaction,
  input: {
    readonly scope: PrivateRunFileScope;
    readonly runId: string;
    readonly executionAuthorityEpoch: number;
    readonly leaseToken: string;
  },
): Promise<FenceResult> {
  const workspace = await transaction.query<LockedWorkspace>(
    `select management_state as "managementState"
       from takosumi_workspaces
      where id = $1
      for update`,
    [input.scope.workspaceId],
  );
  if (workspace.rows[0]?.managementState !== "active") return "rejected";

  const capsule = await transaction.query<LockedCapsule>(
    `select space_id as "workspaceId",
            environment,
            execution_authority_epoch as "executionAuthorityEpoch"
       from takosumi_capsules
      where id = $1
      for update`,
    [input.scope.capsuleId],
  );
  const capsuleRow = capsule.rows[0];
  if (
    capsuleRow === undefined ||
    capsuleRow.workspaceId !== input.scope.workspaceId ||
    capsuleRow.environment !== input.scope.environment ||
    parseEpoch(capsuleRow.executionAuthorityEpoch) !==
      input.executionAuthorityEpoch
  )
    return "rejected";

  const run = await transaction.query<LockedRun>(
    `select space_id as "workspaceId",
            installation_id as "capsuleId",
            kind,
            status,
            lease_token as "leaseToken",
            run_json as "runJson"
       from takosumi_runs
      where id = $1
      for update`,
    [input.runId],
  );
  const runRow = run.rows[0];
  if (
    runRow === undefined ||
    runRow.workspaceId !== input.scope.workspaceId ||
    runRow.capsuleId !== input.scope.capsuleId ||
    !knownRunKinds.has(runRow.kind) ||
    runRow.status !== "running" ||
    runRow.leaseToken !== input.leaseToken
  )
    return "rejected";
  const capturedEpoch = capturedRunEpoch(runRow);
  if (capturedEpoch !== input.executionAuthorityEpoch) return "rejected";
  return "accepted";
}

function capturedRunEpoch(run: LockedRun): number | undefined {
  const record = run.runJson;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return undefined;
  }
  const value = record as Record<string, unknown>;
  let epoch: unknown;
  if (
    run.kind === "plan" ||
    run.kind === "destroy_plan" ||
    run.kind === "drift_check"
  ) {
    epoch = value.capsuleExecutionAuthorityEpoch;
  } else if (run.kind === "apply" || run.kind === "destroy_apply") {
    const expected = value.expected;
    if (
      typeof expected !== "object" ||
      expected === null ||
      Array.isArray(expected)
    ) {
      return undefined;
    }
    epoch = (expected as Record<string, unknown>)
      .capsuleExecutionAuthorityEpoch;
  } else {
    // Generic Run rows have no canonical Capsule epoch field. Never infer one
    // from the Capsule's current epoch or add a new payload property here.
    return undefined;
  }
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 1
    ? epoch
    : undefined;
}

function scopeParameters(scope: PrivateRunFileScope) {
  return [
    scope.workspaceId,
    scope.capsuleId,
    scope.environment,
    scope.slot,
  ] as const;
}

function parseReceipt(row: ReceiptRow): PrivateRunFileReceipt {
  const scope: PrivateRunFileScope = {
    workspaceId: requiredText(row.workspaceId),
    capsuleId: requiredText(row.capsuleId),
    environment: requiredText(row.environment),
    slot: requiredText(row.slot),
  };
  const commitId = requiredText(row.commitId);
  const expectedVersion = parseVersion(row.expectedVersion, true);
  const version = parseVersion(row.version);
  const digest = parseDigest(row.digest);
  const blobId = requiredText(row.blobId);
  if (version !== expectedVersion + 1) {
    throw new Error("invalid private run file receipt");
  }
  return { scope, commitId, expectedVersion, version, digest, blobId };
}

function parsePointer(row: PointerRow): PrivateRunFilePointer {
  return {
    version: parseVersion(row.version),
    digest: parseDigest(row.digest),
    blobId: requiredText(row.blobId),
  };
}

function sameReceipt(
  receipt: PrivateRunFileReceipt,
  input: {
    readonly scope: PrivateRunFileScope;
    readonly expectedVersion: number;
    readonly commitId: string;
    readonly digest: string;
  },
) {
  return (
    receipt.commitId === input.commitId &&
    receipt.expectedVersion === input.expectedVersion &&
    receipt.version === input.expectedVersion + 1 &&
    receipt.digest === input.digest &&
    receipt.scope.workspaceId === input.scope.workspaceId &&
    receipt.scope.capsuleId === input.scope.capsuleId &&
    receipt.scope.environment === input.scope.environment &&
    receipt.scope.slot === input.scope.slot
  );
}

function parseVersion(value: number | string, allowZero = false) {
  const version = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < (allowZero ? 0 : 1)) {
    throw new Error("invalid private run file version");
  }
  return version;
}

function parseEpoch(value: number | string) {
  const epoch = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("invalid Capsule epoch");
  }
  return epoch;
}

function parseDigest(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid private run file digest");
  }
  return value as `sha256:${string}`;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("invalid private run file value");
  }
  return value;
}
