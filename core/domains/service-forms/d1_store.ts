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
import { deployControlD1TableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { D1Like } from "../resource-shape/d1_stores.ts";
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

interface JsonRow {
  readonly record_json: string;
}

export class D1FormRegistryStore implements FormRegistryStore {
  constructor(readonly db: D1Like) {}

  async installPackage(
    packageRecord: FormPackageRecord,
    definitions: readonly FormDefinitionRecord[],
  ): Promise<InstallFormPackageResult> {
    const existing = await this.getPackage(packageRecord.packageDigest);
    if (existing !== undefined) {
      return (await this.#installEquivalent(
        existing,
        packageRecord,
        definitions,
      ))
        ? { status: "already_installed", package: existing }
        : { status: "conflict", reason: "package_digest_conflict" };
    }
    if (this.db.batch === undefined) {
      throw new Error("D1 Form registry requires atomic batch support");
    }
    const statements = [
      this.db
        .prepare(
          `insert into ${names.serviceFormPackages}
            (package_digest, status, record_json, installed_at, updated_at)
           values (?,?,?,?,?)`,
        )
        .bind(...packageParameters(packageRecord)),
      ...definitions.map((definition) =>
        this.db
          .prepare(
            `insert into ${names.serviceFormDefinitions}
              (form_ref_key, package_digest, api_version, kind,
               definition_version, schema_digest, record_json, installed_at)
             values (?,?,?,?,?,?,?,?)`,
          )
          .bind(...definitionParameters(definition)),
      ),
    ];
    try {
      await this.db.batch(statements);
      return { status: "installed", package: structuredClone(packageRecord) };
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      const racedPackage = await this.getPackage(packageRecord.packageDigest);
      if (
        racedPackage !== undefined &&
        (await this.#installEquivalent(
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

  async getPackage(
    packageDigest: string,
  ): Promise<FormPackageRecord | undefined> {
    const row = await this.db
      .prepare(
        `select record_json from ${names.serviceFormPackages}
         where package_digest = ? limit 1`,
      )
      .bind(packageDigest)
      .first<JsonRow>();
    return decodeOptional<FormPackageRecord>(row);
  }

  async listPackages(params: PageParams): Promise<Page<FormPackageRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = await this.db
      .prepare(
        `select record_json from ${names.serviceFormPackages}
         ${cursor ? "where (updated_at > ? or (updated_at = ? and package_digest > ?))" : ""}
         order by updated_at asc, package_digest asc limit ?`,
      )
      .bind(
        ...(cursor
          ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
          : [limit + 1]),
      )
      .all<JsonRow>();
    return pageFromProbeBy(
      (rows.results ?? []).map((row) =>
        decode<FormPackageRecord>(row.record_json),
      ),
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
      const result = await this.db
        .prepare(
          `update ${names.serviceFormPackages}
           set status = ?, record_json = ?, updated_at = ?
           where package_digest = ? and status = ?`,
        )
        .bind(
          status,
          JSON.stringify(next),
          updatedAt,
          packageDigest,
          current.status,
        )
        .run();
      if ((result.meta?.changes ?? 0) > 0) {
        return { status: "updated", package: next };
      }
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
    const row = await this.db
      .prepare(
        `select record_json from ${names.serviceFormDefinitions}
         where form_ref_key = ? limit 1`,
      )
      .bind(formRefKey(ref))
      .first<JsonRow>();
    return decodeOptional<FormDefinitionRecord>(row);
  }

  async listDefinitions(
    params: PageParams,
  ): Promise<Page<FormDefinitionRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = await this.db
      .prepare(
        `select record_json from ${names.serviceFormDefinitions}
         ${cursor ? "where (installed_at > ? or (installed_at = ? and form_ref_key > ?))" : ""}
         order by installed_at asc, form_ref_key asc limit ?`,
      )
      .bind(
        ...(cursor
          ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
          : [limit + 1]),
      )
      .all<JsonRow>();
    return pageFromProbeBy(
      (rows.results ?? []).map((row) =>
        decode<FormDefinitionRecord>(row.record_json),
      ),
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
    const result = await this.db
      .prepare(
        `insert or ignore into ${names.serviceFormActivations}
          (id, form_ref_key, package_digest, scope_type, scope_id, status,
           revision, record_json, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(...activationParameters(activation))
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
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
    const row = await this.db
      .prepare(
        `select record_json from ${names.serviceFormActivations}
         where id = ? limit 1`,
      )
      .bind(id)
      .first<JsonRow>();
    return decodeOptional<FormActivationRecord>(row);
  }

  async listActivations(
    params: PageParams,
  ): Promise<Page<FormActivationRecord>> {
    const limit = clampPageLimit(params.limit);
    const cursor = decodeCursor(params.cursor);
    const rows = await this.db
      .prepare(
        `select record_json from ${names.serviceFormActivations}
         ${cursor ? "where (updated_at > ? or (updated_at = ? and id > ?))" : ""}
         order by updated_at asc, id asc limit ?`,
      )
      .bind(
        ...(cursor
          ? [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1]
          : [limit + 1]),
      )
      .all<JsonRow>();
    return pageFromProbeBy(
      (rows.results ?? []).map((row) =>
        decode<FormActivationRecord>(row.record_json),
      ),
      limit,
      (record) => ({ createdAt: record.updatedAt, id: record.id }),
    );
  }

  async updateActivation(
    activation: FormActivationRecord,
    expectedRevision: number,
  ): Promise<UpdateFormActivationResult> {
    const result = await this.db
      .prepare(
        `update ${names.serviceFormActivations}
         set form_ref_key = ?, package_digest = ?, scope_type = ?, scope_id = ?,
             status = ?, revision = ?, record_json = ?, created_at = ?, updated_at = ?
         where id = ? and revision = ?`,
      )
      .bind(
        ...activationParameters(activation).slice(1),
        activation.id,
        expectedRevision,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      return { status: "updated", activation: structuredClone(activation) };
    }
    const current = await this.getActivation(activation.id);
    return current === undefined
      ? { status: "not_found" }
      : { status: "conflict", activation: current };
  }

  async #installEquivalent(
    existing: FormPackageRecord,
    incoming: FormPackageRecord,
    incomingDefinitions: readonly FormDefinitionRecord[],
  ): Promise<boolean> {
    return packageInstallEquivalent(
      existing,
      incoming,
      await this.#definitionsForPackage(existing.packageDigest),
      incomingDefinitions,
    );
  }

  async #definitionsForPackage(
    packageDigest: string,
  ): Promise<readonly FormDefinitionRecord[]> {
    const rows = await this.db
      .prepare(
        `select record_json from ${names.serviceFormDefinitions}
         where package_digest = ? order by form_ref_key asc`,
      )
      .bind(packageDigest)
      .all<JsonRow>();
    return (rows.results ?? []).map((row) =>
      decode<FormDefinitionRecord>(row.record_json),
    );
  }
}

function packageParameters(record: FormPackageRecord): readonly unknown[] {
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
): readonly unknown[] {
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
): readonly unknown[] {
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

function decode<T>(value: string): T {
  return JSON.parse(value) as T;
}

function decodeOptional<T>(row: JsonRow | null): T | undefined {
  return row === null ? undefined : decode<T>(row.record_json);
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique|primary key/iu.test(message);
}

export function createD1FormRegistryStore(db: D1Like): FormRegistryStore {
  return new D1FormRegistryStore(db);
}
