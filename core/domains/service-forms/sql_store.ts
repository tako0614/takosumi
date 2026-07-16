import {
  clampPageLimit,
  decodeCursor,
  formRefKey,
  pageFromProbeBy,
  type FormPackageLifecycleStatus,
  type FormRef,
  type Page,
  type PageParams,
} from "takosumi-contract";
import { deployControlPostgresTableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type {
  SqlClient,
  SqlTransaction,
  SqlValue,
} from "../../adapters/storage/sql.ts";
import { packageInstallEquivalent } from "./record_equivalence.ts";
import type {
  FormActivationRecord,
  FormDefinitionRecord,
  FormPackageRecord,
} from "./records.ts";
import type {
  CreateFormActivationResult,
  FormRegistryStore,
  InstallFormPackageResult,
  UpdateFormActivationResult,
  UpdateFormPackageStatusResult,
} from "./stores.ts";

type JsonRow = Record<string, unknown> & {
  readonly record_json: unknown;
};

export class SqlFormRegistryStore implements FormRegistryStore {
  constructor(readonly client: SqlClient) {}

  async installPackage(
    packageRecord: FormPackageRecord,
    definitions: readonly FormDefinitionRecord[],
  ): Promise<InstallFormPackageResult> {
    try {
      return await this.client.transaction(async (tx) => {
        const existing = await getPackage(tx, packageRecord.packageDigest);
        if (existing !== undefined) {
          return (await installEquivalent(
            tx,
            existing,
            packageRecord,
            definitions,
          ))
            ? { status: "already_installed", package: existing }
            : { status: "conflict", reason: "package_digest_conflict" };
        }
        await tx.query(
          `insert into ${names.serviceFormPackages}
            (package_digest, status, record_json, installed_at, updated_at)
           values ($1,$2,$3::jsonb,$4,$5)`,
          packageParameters(packageRecord),
        );
        for (const definition of definitions) {
          await tx.query(
            `insert into ${names.serviceFormDefinitions}
              (form_ref_key, package_digest, api_version, kind,
               definition_version, schema_digest, record_json, installed_at)
             values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
            definitionParameters(definition),
          );
        }
        return {
          status: "installed" as const,
          package: structuredClone(packageRecord),
        };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const racedPackage = await this.getPackage(packageRecord.packageDigest);
      if (
        racedPackage !== undefined &&
        (await installEquivalent(
          this.client,
          racedPackage,
          packageRecord,
          definitions,
        ))
      ) {
        return { status: "already_installed", package: racedPackage };
      }
      for (const definition of definitions) {
        if (
          (await this.getDefinition(definition.identity.formRef)) !== undefined
        ) {
          return { status: "conflict", reason: "form_ref_conflict" };
        }
      }
      return { status: "conflict", reason: "package_digest_conflict" };
    }
  }

  getPackage(packageDigest: string): Promise<FormPackageRecord | undefined> {
    return getPackage(this.client, packageDigest);
  }

  async listPackages(params: PageParams): Promise<Page<FormPackageRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const parameters: SqlValue[] = cursor
      ? [cursor.createdAt, cursor.id, limit + 1]
      : [limit + 1];
    const result = await this.client.query<JsonRow>(
      `select record_json from ${names.serviceFormPackages}
       ${cursor ? "where (updated_at, package_digest) > ($1,$2)" : ""}
       order by updated_at asc, package_digest asc limit $${parameters.length}`,
      parameters,
    );
    return pageFromProbeBy(
      result.rows.map((row) => decode<FormPackageRecord>(row.record_json)),
      limit,
      (record) => ({
        createdAt: record.updatedAt,
        id: record.packageDigest,
      }),
    );
  }

  async updatePackageStatus(
    packageDigest: string,
    status: FormPackageLifecycleStatus,
    updatedAt: string,
  ): Promise<UpdateFormPackageStatusResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getPackage(packageDigest);
      if (current === undefined) return { status: "not_found" };
      if (current.status === "revoked" && status !== "revoked") {
        return { status: "invalid_transition", package: current };
      }
      if (current.status === status) {
        return { status: "updated", package: current };
      }
      const next: FormPackageRecord = {
        ...current,
        status,
        updatedAt,
        ...(status === "deprecated" ? { deprecatedAt: updatedAt } : {}),
        ...(status === "revoked" ? { revokedAt: updatedAt } : {}),
      };
      const result = await this.client.query(
        `update ${names.serviceFormPackages}
         set status = $1, record_json = $2::jsonb, updated_at = $3
         where package_digest = $4 and status = $5`,
        [
          status,
          JSON.stringify(next),
          updatedAt,
          packageDigest,
          current.status,
        ],
      );
      if (result.rowCount > 0) return { status: "updated", package: next };
    }
    const current = await this.getPackage(packageDigest);
    if (current === undefined) return { status: "not_found" };
    if (current.status === "revoked" && status !== "revoked") {
      return { status: "invalid_transition", package: current };
    }
    if (current.status === status) {
      return { status: "updated", package: current };
    }
    throw new Error(
      `package status update did not converge for ${packageDigest}`,
    );
  }

  async getDefinition(ref: FormRef): Promise<FormDefinitionRecord | undefined> {
    const result = await this.client.query<JsonRow>(
      `select record_json from ${names.serviceFormDefinitions}
       where form_ref_key = $1 limit 1`,
      [formRefKey(ref)],
    );
    return result.rows[0] === undefined
      ? undefined
      : decode<FormDefinitionRecord>(result.rows[0].record_json);
  }

  async listDefinitions(
    params: PageParams,
  ): Promise<Page<FormDefinitionRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const parameters: SqlValue[] = cursor
      ? [cursor.createdAt, cursor.id, limit + 1]
      : [limit + 1];
    const result = await this.client.query<JsonRow>(
      `select record_json from ${names.serviceFormDefinitions}
       ${cursor ? "where (installed_at, form_ref_key) > ($1,$2)" : ""}
       order by installed_at asc, form_ref_key asc limit $${parameters.length}`,
      parameters,
    );
    return pageFromProbeBy(
      result.rows.map((row) => decode<FormDefinitionRecord>(row.record_json)),
      limit,
      (record) => ({
        createdAt: record.installedAt,
        id: formRefKey(record.identity.formRef),
      }),
    );
  }

  async createActivation(
    activation: FormActivationRecord,
  ): Promise<CreateFormActivationResult> {
    const result = await this.client.query(
      `insert into ${names.serviceFormActivations}
        (id, form_ref_key, package_digest, scope_type, scope_id, status,
         revision, record_json, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       on conflict do nothing`,
      activationParameters(activation),
    );
    if (result.rowCount > 0) {
      return { status: "created", activation: structuredClone(activation) };
    }
    const current = await this.getActivation(activation.id);
    if (current === undefined) {
      throw new Error(
        `activation create conflict did not resolve ${activation.id}`,
      );
    }
    return { status: "conflict", activation: current };
  }

  async getActivation(id: string): Promise<FormActivationRecord | undefined> {
    const result = await this.client.query<JsonRow>(
      `select record_json from ${names.serviceFormActivations}
       where id = $1 limit 1`,
      [id],
    );
    return result.rows[0] === undefined
      ? undefined
      : decode<FormActivationRecord>(result.rows[0].record_json);
  }

  async listActivations(
    params: PageParams,
  ): Promise<Page<FormActivationRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const parameters: SqlValue[] = cursor
      ? [cursor.createdAt, cursor.id, limit + 1]
      : [limit + 1];
    const result = await this.client.query<JsonRow>(
      `select record_json from ${names.serviceFormActivations}
       ${cursor ? "where (updated_at, id) > ($1,$2)" : ""}
       order by updated_at asc, id asc limit $${parameters.length}`,
      parameters,
    );
    return pageFromProbeBy(
      result.rows.map((row) => decode<FormActivationRecord>(row.record_json)),
      limit,
      (record) => ({ createdAt: record.updatedAt, id: record.id }),
    );
  }

  async updateActivation(
    activation: FormActivationRecord,
    expectedRevision: number,
  ): Promise<UpdateFormActivationResult> {
    const parameters = activationParameters(activation);
    const result = await this.client.query(
      `update ${names.serviceFormActivations}
       set form_ref_key=$2, package_digest=$3, scope_type=$4, scope_id=$5,
           status=$6, revision=$7, record_json=$8::jsonb,
           created_at=$9, updated_at=$10
       where id=$1 and revision=$11`,
      [...parameters, expectedRevision],
    );
    if (result.rowCount > 0) {
      return { status: "updated", activation: structuredClone(activation) };
    }
    const current = await this.getActivation(activation.id);
    return current === undefined
      ? { status: "not_found" }
      : { status: "conflict", activation: current };
  }
}

async function getPackage(
  client: SqlClient | SqlTransaction,
  packageDigest: string,
): Promise<FormPackageRecord | undefined> {
  const result = await client.query<JsonRow>(
    `select record_json from ${names.serviceFormPackages}
     where package_digest = $1 limit 1`,
    [packageDigest],
  );
  return result.rows[0] === undefined
    ? undefined
    : decode<FormPackageRecord>(result.rows[0].record_json);
}

async function definitionsForPackage(
  client: SqlClient | SqlTransaction,
  packageDigest: string,
): Promise<readonly FormDefinitionRecord[]> {
  const result = await client.query<JsonRow>(
    `select record_json from ${names.serviceFormDefinitions}
     where package_digest = $1 order by form_ref_key asc`,
    [packageDigest],
  );
  return result.rows.map((row) =>
    decode<FormDefinitionRecord>(row.record_json),
  );
}

async function installEquivalent(
  client: SqlClient | SqlTransaction,
  existing: FormPackageRecord,
  incoming: FormPackageRecord,
  incomingDefinitions: readonly FormDefinitionRecord[],
): Promise<boolean> {
  return packageInstallEquivalent(
    existing,
    incoming,
    await definitionsForPackage(client, existing.packageDigest),
    incomingDefinitions,
  );
}

function packageParameters(record: FormPackageRecord): readonly SqlValue[] {
  return [
    record.packageDigest,
    record.status,
    JSON.stringify(record),
    record.installedAt,
    record.updatedAt,
  ];
}

function definitionParameters(
  record: FormDefinitionRecord,
): readonly SqlValue[] {
  const ref = record.identity.formRef;
  return [
    formRefKey(ref),
    record.identity.packageDigest,
    ref.apiVersion,
    ref.kind,
    ref.definitionVersion,
    ref.schemaDigest,
    JSON.stringify(record),
    record.installedAt,
  ];
}

function activationParameters(
  record: FormActivationRecord,
): readonly SqlValue[] {
  return [
    record.id,
    formRefKey(record.identity.formRef),
    record.identity.packageDigest,
    record.scope.type,
    record.scope.type === "operator" ? null : record.scope.id,
    record.status,
    record.revision,
    JSON.stringify(record),
    record.createdAt,
    record.updatedAt,
  ];
}

function decode<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "23505" || /duplicate key|unique constraint/iu.test(message);
}

export function createSqlFormRegistryStore(
  client: SqlClient,
): FormRegistryStore {
  return new SqlFormRegistryStore(client);
}
