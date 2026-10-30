import type { Interface, InterfaceBinding, InterfaceLink } from "takosumi-contract/interfaces";
import {
  clampPageLimit,
  decodeCursor,
  pageFromProbeBy,
} from "takosumi-contract/pagination";
import {
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
} from "takosumi-contract";
import type { SqlClient, SqlTransaction, SqlValue } from "../../adapters/storage/sql.ts";
import { deployControlPostgresTableNames as names } from "../../adapters/storage/drizzle/schema/logical.ts";
import type { InterfaceMaterializationWriteAuthority } from "../deploy-control/interface_materialization_intent.ts";
import {
  assertWorkspaceManagementAdmission,
  assertWorkspaceManagementAuthorityInput,
  type WorkspaceManagementAuthority,
} from "../deploy-control/store.ts";
import { pgWorkspaceManagementForTransaction } from "../deploy-control/store_sql.ts";
import type {
  InterfaceAuthorizationPageInput,
  InterfaceAuthorizationQuery,
  InterfaceBindingStore,
  InterfaceLinkKey,
  InterfaceLinkReplacement,
  InterfaceLinkStore,
  InterfaceListFilter,
  InterfaceStore,
  InterfaceStores,
  InterfaceWriteGuard,
} from "./stores.ts";
import { isCurrentInterfaceLink, isValidInterfaceLinkReplacement, isValidInterfaceLinkUpdate } from "./stores.ts";
import { interfaceOAuth2ResourceUri } from "./oauth_resource.ts";
import { registerIdentityPrincipalStorage } from "../identity-reconciliation/storage-identity.ts";

type InterfaceRow = { readonly record_json: unknown };
type InterfaceBindingRow = { readonly record_json: unknown };

function decode<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

class SqlInterfaceStore implements InterfaceStore {
  readonly #table = names.interfaces;

  constructor(readonly client: SqlClient) {}

  async create(
    record: Interface,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (authority && !interfaceMatchesAuthority(record, authority)) return false;
    const parameters = [...interfaceParameters(record, false)];
    const authorityClause = postgresMaterializationAuthorityClause(
      parameters,
      authority,
    );
    const result = await this.client.query(
      `insert into ${this.#table} (
        id, workspace_id, owner_kind, owner_id, name, interface_type,
        phase, generation, resolved_revision, oauth_resource_uri,
        record_json, created_at, updated_at
      ) select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13
      where ${authorityClause}
      on conflict do nothing`,
      parameters,
    );
    return result.rowCount > 0;
  }

  async get(id: string): Promise<Interface | undefined> {
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    return result.rows[0]
      ? decode<Interface>(result.rows[0].record_json)
      : undefined;
  }

  async getByName(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly name: string;
  }): Promise<Interface | undefined> {
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table}
       where workspace_id = $1 and owner_kind = $2 and owner_id = $3
         and name = $4 and phase <> 'Retired' limit 1`,
      [input.workspaceId, input.ownerKind, input.ownerId, input.name],
    );
    return result.rows[0]
      ? decode<Interface>(result.rows[0].record_json)
      : undefined;
  }

  async list(filter: InterfaceListFilter): Promise<readonly Interface[]> {
    if (filter.ownerIds?.length === 0) return [];
    const clauses = ["workspace_id = $1"];
    const parameters: SqlValue[] = [filter.workspaceId];
    const add = (sql: string, value: SqlValue): void => {
      parameters.push(value);
      clauses.push(sql.replace("?", `$${parameters.length}`));
    };
    if (filter.type !== undefined) add("interface_type = ?", filter.type);
    if (filter.phase !== undefined) add("phase = ?", filter.phase);
    if (filter.ownerKind !== undefined) add("owner_kind = ?", filter.ownerKind);
    if (filter.ownerId !== undefined) add("owner_id = ?", filter.ownerId);
    if (filter.ownerIds !== undefined) {
      const placeholders = filter.ownerIds.map((ownerId) => {
        parameters.push(ownerId);
        return `$${parameters.length}`;
      });
      clauses.push(`owner_id in (${placeholders.join(",")})`);
    }
    if (filter.includeRetired !== true) clauses.push("phase <> 'Retired'");
    if (filter.limit !== undefined) parameters.push(filter.limit);
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table}
       where ${clauses.join(" and ")} order by name asc, id asc${
         filter.limit === undefined ? "" : ` limit $${parameters.length}`
       }`,
      parameters,
    );
    return result.rows.map((row) => decode<Interface>(row.record_json));
  }

  async listProjectionPage(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<readonly Interface[]> {
    const parameters: SqlValue[] = input.cursor
      ? [input.cursor, input.limit]
      : [input.limit];
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table}
       ${input.cursor ? "where id > $1" : ""}
       order by id asc limit $${parameters.length}`,
      parameters,
    );
    return result.rows.map((row) => decode<Interface>(row.record_json));
  }

  async compareAndSet(
    record: Interface,
    expected: InterfaceWriteGuard,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (authority && !interfaceMatchesAuthority(record, authority)) return false;
    if (
      expected.requireActiveWorkspace === true &&
      record.metadata.workspaceId !== expected.record.metadata.workspaceId
    ) {
      return false;
    }
    const p = interfaceParameters(record, true);
    const parameters: SqlValue[] = [
      ...p,
      expected.generation,
      expected.resolvedRevision,
      JSON.stringify(expected.record),
    ];
    if (expected.requireActiveWorkspace !== true) {
      const authorityClause = postgresMaterializationAuthorityClause(
        parameters,
        authority,
      );
      try {
        const result = await this.client.query(
          `update ${this.#table} set
          workspace_id=$2, owner_kind=$3, owner_id=$4, name=$5,
          interface_type=$6, phase=$7, generation=$8, resolved_revision=$9,
          oauth_resource_uri=case
            when oauth_resource_uri=$10 then oauth_resource_uri else null end,
          record_json=$11::jsonb, created_at=$12, updated_at=$13
         where id=$1 and generation=$14 and resolved_revision=$15
           and record_json=$16::jsonb and ${authorityClause}`,
          parameters,
        );
        return result.rowCount > 0;
      } catch (error) {
        if (isUniqueConstraintError(error)) return false;
        throw error;
      }
    }

    // A queued observer is a new management admission. Read the persisted
    // Interface Workspace, lock that exact Workspace, and only then issue the
    // CAS. The candidate payload never selects the Workspace authority.
    return await this.client.transaction(async (transaction) => {
      const currentRows = await transaction.query<{
        readonly workspaceId: string | null;
      }>(
        `select workspace_id as "workspaceId"
           from ${this.#table}
          where id = $1
          limit 1`,
        [record.metadata.id],
      );
      const actualWorkspaceId = currentRows.rows[0]?.workspaceId;
      if (!actualWorkspaceId) return false;
      const management = await pgWorkspaceManagementForTransaction(
        transaction,
        actualWorkspaceId,
      );
      assertWorkspaceManagementAdmission(management, actualWorkspaceId);
      if (actualWorkspaceId !== expected.record.metadata.workspaceId) {
        return false;
      }

      const guardedParameters: SqlValue[] = [
        ...parameters,
        actualWorkspaceId,
      ];
      const authorityClause = postgresMaterializationAuthorityClause(
        guardedParameters,
        authority,
      );
      try {
        const result = await transaction.query(
          `update ${this.#table} set
          workspace_id=$2, owner_kind=$3, owner_id=$4, name=$5,
          interface_type=$6, phase=$7, generation=$8, resolved_revision=$9,
          oauth_resource_uri=case
            when oauth_resource_uri=$10 then oauth_resource_uri else null end,
          record_json=$11::jsonb, created_at=$12, updated_at=$13
         where id=$1 and workspace_id=$17 and generation=$14
           and resolved_revision=$15 and record_json=$16::jsonb
           and ${authorityClause}`,
          guardedParameters,
        );
        return result.rowCount > 0;
      } catch (error) {
        if (isUniqueConstraintError(error)) return false;
        throw error;
      }
    });
  }

  async claimOAuth2Resource(input: {
    readonly record: Interface;
    readonly resource: string;
  }, authority?: InterfaceMaterializationWriteAuthority): Promise<boolean> {
    if (interfaceOAuth2ResourceUri(input.record) !== input.resource) {
      return false;
    }
    if (authority && !interfaceMatchesAuthority(input.record, authority)) {
      return false;
    }
    const parameters: SqlValue[] = [
      input.resource,
      input.record.metadata.id,
      input.record.metadata.workspaceId,
      input.record.metadata.ownerRef.kind,
      input.record.metadata.ownerRef.id,
      input.record.metadata.generation,
      input.record.status.resolvedRevision,
      JSON.stringify(input.record),
    ];
    const authorityClause = postgresMaterializationAuthorityClause(
      parameters,
      authority,
    );
    try {
      const result = await this.client.query(
        `update ${this.#table} set oauth_resource_uri=$1
         where id=$2 and workspace_id=$3 and owner_kind=$4 and owner_id=$5
           and phase='Resolved' and generation=$6 and resolved_revision=$7
           and record_json=$8::jsonb and ${authorityClause}`,
        parameters,
      );
      return result.rowCount > 0;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async findOAuth2ResourceClaim(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly resource: string;
  }): Promise<string | undefined> {
    const result = await this.client.query<{ readonly id: string }>(
      `select id from ${this.#table}
       where workspace_id=$1 and owner_kind=$2 and owner_id=$3
         and oauth_resource_uri=$4 limit 1`,
      [input.workspaceId, input.ownerKind, input.ownerId, input.resource],
    );
    return result.rows[0]?.id;
  }
}

class SqlInterfaceBindingStore implements InterfaceBindingStore {
  readonly #table = names.interfaceBindings;

  constructor(readonly client: SqlClient) { registerIdentityPrincipalStorage(this, client); }

  async create(
    record: InterfaceBinding,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (authority && record.metadata.workspaceId !== authority.workspaceId) {
      return false;
    }
    const parameters = [...bindingParameters(record)];
    const authorityClause = postgresMaterializationAuthorityClause(
      parameters,
      authority,
      record.spec.interfaceId,
    );
    const result = await this.client.query(
      `insert into ${this.#table} (
        id, workspace_id, interface_id, subject_kind, subject_id,
        phase, generation, record_json, created_at, updated_at
      ) select $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10
      where ${authorityClause}
      on conflict do nothing`,
      parameters,
    );
    return result.rowCount > 0;
  }

  async get(id: string): Promise<InterfaceBinding | undefined> {
    const result = await this.client.query<InterfaceBindingRow>(
      `select record_json from ${this.#table} where id = $1 limit 1`,
      [id],
    );
    return result.rows[0]
      ? decode<InterfaceBinding>(result.rows[0].record_json)
      : undefined;
  }

  async listByInterface(
    interfaceId: string,
  ): Promise<readonly InterfaceBinding[]> {
    const result = await this.client.query<InterfaceBindingRow>(
      `select record_json from ${this.#table}
       where interface_id = $1 order by created_at asc, id asc`,
      [interfaceId],
    );
    return result.rows.map((row) => decode<InterfaceBinding>(row.record_json));
  }

  async compareAndSet(
    record: InterfaceBinding,
    expectedGeneration: number,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (authority && record.metadata.workspaceId !== authority.workspaceId) {
      return false;
    }
    const p = bindingParameters(record);
    const parameters: SqlValue[] = [...p, expectedGeneration];
    const authorityClause = postgresMaterializationAuthorityClause(
      parameters,
      authority,
      record.spec.interfaceId,
    );
    const result = await this.client.query(
      `update ${this.#table} set
        workspace_id=$2, interface_id=$3, subject_kind=$4, subject_id=$5,
        phase=$6, generation=$7, record_json=$8::jsonb,
        created_at=$9, updated_at=$10
       where id=$1 and generation=$11 and ${authorityClause}`,
      parameters,
    );
    return result.rowCount > 0;
  }
}

class SqlInterfaceLinkStore implements InterfaceLinkStore {
  readonly #table = names.interfaceLinks;

  constructor(readonly client: SqlClient) {}

  async create(record: InterfaceLink, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    if (record.generation !== 1 || !isCurrentInterfaceLink(record)) return false;
    return await this.#withManagementGuard(guard, async (client) => {
      const result = await client.query(
        `insert into ${this.#table} (${LINK_COLUMNS}) select ${LINK_PLACEHOLDERS}
         where not exists (select 1 from ${this.#table} where consumer_capsule_id=$3 and requirement_key=$4)
         on conflict do nothing`, linkParameters(record),
      );
      return result.rowCount > 0;
    });
  }

  async get(id: string): Promise<InterfaceLink | undefined> {
    const result = await this.client.query<InterfaceRow>(`select record_json from ${this.#table} where id=$1 limit 1`, [id]);
    return result.rows[0] ? decode<InterfaceLink>(result.rows[0].record_json) : undefined;
  }

  getCurrent(key: InterfaceLinkKey): Promise<InterfaceLink | undefined> { return this.#find(key, true); }
  getLatest(key: InterfaceLinkKey): Promise<InterfaceLink | undefined> { return this.#find(key, false); }

  async #find(key: InterfaceLinkKey, current: boolean): Promise<InterfaceLink | undefined> {
    const result = await this.client.query<InterfaceRow>(
      `select record_json from ${this.#table} where consumer_capsule_id=$1 and requirement_key=$2
       ${current ? "and state in ('pending_approval','active')" : ""} order by generation desc limit 1`,
      [key.consumerCapsuleId, key.requirementKey],
    );
    return result.rows[0] ? decode<InterfaceLink>(result.rows[0].record_json) : undefined;
  }

  listByConsumerCapsule(id: string): Promise<readonly InterfaceLink[]> { return this.#list("consumer_capsule_id", id); }
  listByProviderInterface(id: string): Promise<readonly InterfaceLink[]> { return this.#list("provider_interface_id", id); }
  listByProviderCapsule(id: string): Promise<readonly InterfaceLink[]> { return this.#list("provider_capsule_id", id); }

  async #list(column: string, id: string): Promise<readonly InterfaceLink[]> {
    const result = await this.client.query<InterfaceRow>(`select record_json from ${this.#table} where ${column}=$1 order by created_at asc, id asc`, [id]);
    return result.rows.map((row) => decode<InterfaceLink>(row.record_json));
  }

  async compareAndSet(record: InterfaceLink, expectedGeneration: number, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    const prior = await this.get(record.id);
    if (!prior || prior.generation !== expectedGeneration || !isValidInterfaceLinkUpdate(record, prior)) return false;
    return await this.#withManagementGuard(guard, async (client) => {
      const result = await client.query(
        `update ${this.#table} set generation=$1, state=$2, record_json=$3::jsonb, updated_at=$4
         where id=$5 and generation=$6 and record_json=$7::jsonb`,
        [record.generation, record.state, JSON.stringify(record), record.updatedAt, record.id, expectedGeneration, JSON.stringify(prior)],
      );
      return result.rowCount > 0;
    });
  }

  async replace(input: InterfaceLinkReplacement, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    if (!isValidInterfaceLinkReplacement(input)) return false;
    const { record, expected, revoked } = input;
    try {
      return await this.client.transaction(async (transaction) => {
        if (!await this.#managementCurrent(transaction, guard)) return false;
        // Every replacement locks the exact prior row, including a terminal
        // prior. The latest-lineage guard prevents a stale terminal selection
        // from becoming a second winner after another replacement committed.
        const prior = await transaction.query<InterfaceRow>(
          `select record_json from ${this.#table} where id=$1 and generation=$2 and record_json=$3::jsonb for update`,
          [expected.id, expected.generation, JSON.stringify(expected)],
        );
        if (!prior.rows[0]) return false;
        const newer = await transaction.query(`select 1 from ${this.#table}
          where consumer_capsule_id=$1 and requirement_key=$2 and generation>$3 limit 1`,
          [expected.consumerCapsuleId, expected.requirementKey, expected.generation]);
        if (newer.rowCount > 0) return false;
        if (revoked) await transaction.query(
          `update ${this.#table} set generation=$1, state=$2, record_json=$3::jsonb, updated_at=$4 where id=$5`,
          [revoked.generation, revoked.state, JSON.stringify(revoked), revoked.updatedAt, expected.id],
        );
        await transaction.query(`insert into ${this.#table} (${LINK_COLUMNS}) values (${LINK_PLACEHOLDERS})`, linkParameters(record));
        return true;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async #managementCurrent(client: SqlTransaction, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    if (!guard) return true;
    assertWorkspaceManagementAuthorityInput(guard, guard.workspaceId);
    const actual = await pgWorkspaceManagementForTransaction(client, guard.workspaceId);
    return actual?.managementState === "active" && actual.managementEpoch === guard.managementEpoch;
  }

  async #withManagementGuard(guard: WorkspaceManagementAuthority | undefined, write: (client: SqlClient) => Promise<boolean>): Promise<boolean> {
    if (!guard) return await write(this.client);
    return await this.client.transaction(async (transaction) =>
      await this.#managementCurrent(transaction, guard) ? await write(transaction) : false);
  }
}

const LINK_COLUMNS = "id, generation, consumer_capsule_id, requirement_key, provider_interface_id, provider_capsule_id, state, record_json, created_at, updated_at";
const LINK_PLACEHOLDERS = "$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10";
function linkParameters(record: InterfaceLink): readonly SqlValue[] {
  return [record.id, record.generation, record.consumerCapsuleId, record.requirementKey,
    record.providerInterfaceId, record.providerCapsuleId, record.state, JSON.stringify(record), record.createdAt, record.updatedAt];
}

class SqlInterfaceAuthorizationQuery implements InterfaceAuthorizationQuery {
  readonly #interfaces = names.interfaces;
  readonly #bindings = names.interfaceBindings;

  constructor(readonly client: SqlClient) {}

  async listPage(
    input: InterfaceAuthorizationPageInput,
  ): ReturnType<InterfaceAuthorizationQuery["listPage"]> {
    if (input.filter.ownerIds?.length === 0) return { items: [] };
    if (
      input.filter.phase !== undefined &&
      input.filter.phase !== "Resolved"
    ) {
      return { items: [] };
    }
    // Without a partition (TASK-0118 9.1) this read is not partition-indexed;
    // see the D1 store note on the subject-first Binding index for 9.6.
    const parameters: SqlValue[] = [];
    const clauses = ["i.phase = 'Resolved'"];
    if (input.filter.workspaceId !== undefined) {
      parameters.push(input.filter.workspaceId);
      clauses.unshift(`i.workspace_id = $${parameters.length}`);
    }
    clauses.push(
      `not exists (
        select 1
        from jsonb_each(
          case
            when jsonb_typeof(i.record_json->'spec'->'inputs') = 'object'
              then i.record_json->'spec'->'inputs'
            else '{}'::jsonb
          end
        ) as capsule_input(name, input_value)
        where capsule_input.input_value->>'source' = 'capsule_output'
          and (
            i.owner_kind <> 'Capsule'
            or jsonb_typeof(capsule_input.input_value->'capsuleId') <> 'string'
            or capsule_input.input_value->>'capsuleId' is distinct from i.owner_id
          )
      )`,
    );
    const placeholder = (value: SqlValue): string => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    const add = (column: string, value: SqlValue): void => {
      clauses.push(`${column} = ${placeholder(value)}`);
    };
    if (input.uiSurfaceCandidates) {
      const type = placeholder(UI_SURFACE_INTERFACE_TYPE);
      const version = placeholder(UI_SURFACE_INTERFACE_VERSION);
      const capsuleOwnerClause = input.capsuleId
        ? `and i.owner_id = ${placeholder(input.capsuleId)}`
        : "";
      clauses.push(
        `(i.owner_kind = 'Capsule' and i.interface_type = ${type}
          and i.record_json->'spec'->>'version' = ${version}
          ${capsuleOwnerClause})`,
      );
    } else {
      if (input.filter.type !== undefined)
        add("i.interface_type", input.filter.type);
      if (input.filter.ownerKind !== undefined)
        add("i.owner_kind", input.filter.ownerKind);
      if (input.filter.ownerId !== undefined)
        add("i.owner_id", input.filter.ownerId);
      if (input.filter.ownerIds !== undefined) {
        clauses.push(
          `i.owner_id in (${input.filter.ownerIds
            .map((ownerId) => placeholder(ownerId))
            .join(",")})`,
        );
      }
    }
    if (input.filter.includeRetired !== true)
      clauses.push("i.phase <> 'Retired'");
    const subject = placeholder(input.subjectId);
    const permission = placeholder(JSON.stringify([input.permission]));
    // A Workspace-free runtime principal's evidence: a Binding on an
    // Interface its own app owns, both the app's own records (materialized,
    // or written under the app's or the operator's authority), or one
    // materialized from its own app's link (whose activity the consent
    // clause below still requires).
    const consumerClause = input.consumer
      ? `and ((i.owner_kind = 'Capsule' and i.owner_id = ${placeholder(input.consumer.capsuleId)}
            and (i.record_json->'metadata'->'materializedFrom' is not null
              or i.record_json->'metadata'->>'createdUnder' in ('app', 'operator'))
            and (b.record_json->'metadata'->'materializedFrom' is not null
              or b.record_json->'metadata'->>'createdUnder' in ('app', 'operator')))
          or (b.record_json->'metadata'->'materializedFrom'->>'source' = 'capsule_required_interface'
            and b.record_json->'metadata'->'materializedFrom'->>'capsuleId' = ${placeholder(input.consumer.capsuleId)}))`
      : "";
    clauses.push(
      `exists (
        select 1 from ${this.#bindings} b
        where b.interface_id = i.id
          and b.workspace_id = i.workspace_id
          and b.subject_kind = 'Principal'
          and b.subject_id = ${subject}
          and b.phase = 'Ready'
          and b.record_json->'status'->>'observedInterfaceRevision'
              = i.resolved_revision::text
          and b.record_json->'spec'->'permissions' @> ${permission}::jsonb
          ${consumerClause}
          and (
            coalesce(b.record_json->'metadata'->'materializedFrom'->>'source', '') <> 'capsule_required_interface'
            or exists (
              select 1 from ${names.interfaceLinks} consent
              where (b.record_json->'metadata'->'materializedFrom'->>'linkId' is null
                or consent.id = b.record_json->'metadata'->'materializedFrom'->>'linkId')
                and consent.state = 'active'
                and consent.provider_interface_id = b.interface_id
                and exists (select 1 from ${this.#interfaces} provider
                  where provider.id = b.interface_id and provider.owner_kind = 'Capsule'
                    and provider.owner_id = consent.provider_capsule_id
                    and provider.interface_type = consent.record_json->'interface'->>'type'
                    and provider.record_json->'spec'->>'version' = consent.record_json->'interface'->>'version')
                and consent.record_json->>'deliveryType' = b.record_json->'spec'->'delivery'->>'type'
                and consent.consumer_capsule_id = b.record_json->'metadata'->'materializedFrom'->>'capsuleId'
                and consent.requirement_key = b.record_json->'metadata'->'materializedFrom'->>'requirementKey'
                and consent.record_json->'interface'->>'type' = b.record_json->'metadata'->'materializedFrom'->>'interfaceType'
                and consent.record_json->'interface'->>'version' = b.record_json->'metadata'->'materializedFrom'->>'interfaceVersion'
                and consent.record_json->'requestedPermissions' @> ${permission}::jsonb
                and consent.record_json->'approvedPermissions' @> ${permission}::jsonb
            )
          )
      )`,
    );
    const cursor = decodeCursor(input.params.cursor);
    if (cursor) {
      const createdAfter = placeholder(cursor.createdAt);
      const createdEqual = placeholder(cursor.createdAt);
      const idAfter = placeholder(cursor.id);
      clauses.push(
        `(i.created_at > ${createdAfter} or
          (i.created_at = ${createdEqual} and i.id > ${idAfter}))`,
      );
    }
    const limit = clampPageLimit(input.params.limit);
    const probe = placeholder(limit + 1);
    const result = await this.client.query<InterfaceRow>(
      `select i.record_json from ${this.#interfaces} i
       where ${clauses.join(" and ")}
       order by i.created_at asc, i.id asc
       limit ${probe}`,
      parameters,
    );
    return pageFromProbeBy(
      result.rows.map((row) => decode<Interface>(row.record_json)),
      limit,
      (iface) => ({
        createdAt: iface.metadata.createdAt,
        id: iface.metadata.id,
      }),
    );
  }
}

function interfaceParameters(
  record: Interface,
  preserveClaim: boolean,
): readonly SqlValue[] {
  return [
    record.metadata.id,
    record.metadata.workspaceId,
    record.metadata.ownerRef.kind,
    record.metadata.ownerRef.id,
    record.metadata.name,
    record.spec.type,
    record.status.phase,
    record.metadata.generation,
    record.status.resolvedRevision,
    preserveClaim ? (interfaceOAuth2ResourceUri(record) ?? null) : null,
    JSON.stringify(record),
    record.metadata.createdAt,
    record.metadata.updatedAt,
  ];
}

function bindingParameters(record: InterfaceBinding): readonly SqlValue[] {
  return [
    record.metadata.id,
    record.metadata.workspaceId,
    record.spec.interfaceId,
    record.spec.subjectRef.kind,
    record.spec.subjectRef.id,
    record.status.phase,
    record.metadata.generation,
    JSON.stringify(record),
    record.metadata.createdAt,
    record.metadata.updatedAt,
  ];
}

function interfaceMatchesAuthority(
  record: Interface,
  authority: InterfaceMaterializationWriteAuthority,
): boolean {
  return (
    record.metadata.workspaceId === authority.workspaceId &&
    record.metadata.ownerRef.kind === "Capsule" &&
    record.metadata.ownerRef.id === authority.capsuleId
  );
}

function postgresMaterializationAuthorityClause(
  parameters: SqlValue[],
  authority: InterfaceMaterializationWriteAuthority | undefined,
  interfaceId?: string,
): string {
  if (!authority) return "true";
  const bind = (value: SqlValue): string => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const intentId = bind(authority.intentId);
  const leaseToken = bind(authority.leaseToken);
  const nextItemIndex = bind(authority.expectedNextItemIndex);
  const workspaceId = bind(authority.workspaceId);
  const capsuleId = bind(authority.capsuleId);
  const installConfigId = bind(authority.installConfigId);
  const stateVersionId = bind(authority.stateVersionId);
  const outputId = bind(authority.outputId);
  const stateGeneration = bind(authority.stateGeneration);
  const interfaceOwnership = interfaceId
    ? `and exists (
         select 1 from ${names.interfaces} authority_interface
         where authority_interface.id = ${bind(interfaceId)}
           and authority_interface.workspace_id = ${workspaceId}
           and authority_interface.owner_kind = 'Capsule'
           and authority_interface.owner_id = ${capsuleId}
       )`
    : "";
  return `exists (
    select 1
    from ${names.capsuleInterfaceMaterializationIntents} authority_intent
    join ${names.capsules} authority_capsule
      on authority_capsule.id = authority_intent.capsule_id
     and authority_capsule.space_id = authority_intent.workspace_id
    where authority_intent.id = ${intentId}
      and authority_intent.status = 'pending'
      and authority_intent.lease_token = ${leaseToken}
      and authority_intent.next_item_index = ${nextItemIndex}
      and authority_intent.lease_expires_at is not null
      and authority_intent.lease_expires_at::timestamptz > current_timestamp
      and authority_intent.workspace_id = ${workspaceId}
      and authority_intent.capsule_id = ${capsuleId}
      and authority_intent.install_config_id = ${installConfigId}
      and authority_intent.state_version_id = ${stateVersionId}
      and authority_intent.output_id = ${outputId}
      and authority_intent.state_generation = ${stateGeneration}
      and authority_capsule.install_config_id = ${installConfigId}
      and authority_capsule.status <> 'destroyed'
      and authority_capsule.current_state_version_id = ${stateVersionId}
      and authority_capsule.installation_json->>'currentOutputId' = ${outputId}
      and coalesce(
        (authority_capsule.installation_json->>'currentStateGeneration')::integer,
        0
      ) = ${stateGeneration}
      ${interfaceOwnership}
  )`;
}

export function createSqlInterfaceStores(client: SqlClient): InterfaceStores {
  return {
    persistence: "durable",
    interfaces: new SqlInterfaceStore(client),
    bindings: new SqlInterfaceBindingStore(client),
    links: new SqlInterfaceLinkStore(client),
    authorized: new SqlInterfaceAuthorizationQuery(client),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "23505" || /duplicate key|unique constraint/iu.test(message);
}
