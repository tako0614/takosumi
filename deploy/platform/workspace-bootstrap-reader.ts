import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { d1AccountsTableNames } from "@takosjp/takosumi-accounts-service";
import { extractAccountSessionId } from "../../accounts/service/src/account-session.ts";
import { hashSessionIdWithSalt } from "../../accounts/service/src/session-hash-salt.ts";
import { deployControlD1TableNames } from "../../core/adapters/storage/drizzle/schema/logical.ts";
import {
  DEFAULT_PROJECT_SLUG,
  defaultProjectId,
} from "../../core/domains/projects/mod.ts";
import {
  formatResourceShapeId,
} from "../../core/domains/resource-shape/records.ts";
import type { JsonObject, JsonValue } from "takosumi-contract";
import type { Project } from "takosumi-contract/projects";
import type {
  Workspace,
  WorkspaceMember,
} from "takosumi-contract/workspaces";

import {
  createCloudflareD1PatWorkspaceMembershipReader,
  type CloudflareD1PatWorkspaceMembershipReader,
} from "./pat-workspace-membership-reader.ts";
import type { ReadOnlyD1Database } from "./pat-workspace-membership-reader.ts";

export interface WorkspaceBootstrapReadInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly now: number;
}

export interface PlatformWorkspaceBootstrapTargetPool {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly spec: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlatformWorkspaceBootstrapFacts {
  readonly status: "authenticated_owner";
  readonly subject: TakosumiSubject;
  readonly workspace: Workspace;
  readonly membership: WorkspaceMember;
  readonly defaultProject: Project;
  readonly defaultTargetPool: PlatformWorkspaceBootstrapTargetPool;
}

export type WorkspaceBootstrapReadResult =
  | PlatformWorkspaceBootstrapFacts
  | { readonly status: "invalid_session" }
  | { readonly status: "not_owner" }
  | { readonly status: "incomplete" }
  | { readonly status: "unavailable" };

export interface WorkspaceBootstrapReader {
  read(input: WorkspaceBootstrapReadInput): Promise<WorkspaceBootstrapReadResult>;
}

/**
 * Adapt the canonical Accounts request credential into the zero-write reader.
 *
 * Credential precedence belongs to Accounts' `extractAccountSessionId`; this
 * seam only admits session-shaped credentials and translates unexpected reader
 * failures into the public unavailable result.
 */
export async function readWorkspaceBootstrapRequest(
  reader: WorkspaceBootstrapReader,
  input: {
    readonly request: Request;
    readonly workspaceId: string;
    readonly now: number;
  },
): Promise<WorkspaceBootstrapReadResult> {
  const sessionId = extractAccountSessionId(input.request);
  if (!canonicalSessionId(sessionId)) return { status: "invalid_session" };
  try {
    return await reader.read({
      sessionId,
      workspaceId: input.workspaceId,
      now: input.now,
    });
  } catch {
    return { status: "unavailable" };
  }
}

export interface CloudflareD1WorkspaceBootstrapReaderOptions {
  readonly accountsDb: ReadOnlyD1Database;
  readonly controlDb: ReadOnlyD1Database;
  /** Canonical Accounts session hash salt, injected only at composition time. */
  readonly sessionHashSalt: string;
}

interface AccountsSessionAuthorityRow {
  readonly session_key: unknown;
  readonly session_json: unknown;
  readonly account_key: unknown;
  readonly account_json: unknown;
}

interface WorkspaceBootstrapControlRow {
  readonly workspace_id: unknown;
  readonly workspace_handle: unknown;
  readonly workspace_record_json: unknown;
  readonly workspace_created_at: unknown;
  readonly workspace_updated_at: unknown;
  readonly project_id: unknown;
  readonly project_workspace_id: unknown;
  readonly project_name: unknown;
  readonly project_slug: unknown;
  readonly project_record_json: unknown;
  readonly project_created_at: unknown;
  readonly project_updated_at: unknown;
  readonly target_pool_id: unknown;
  readonly target_pool_space_id: unknown;
  readonly target_pool_name: unknown;
  readonly target_pool_spec_json: unknown;
  readonly target_pool_created_at: unknown;
  readonly target_pool_updated_at: unknown;
}

const ACCOUNTS_SESSION_AUTHORITY_SQL = `with presented_session as (
  select key, document
    from ${d1AccountsTableNames.documents}
   where bucket = 'account_sessions' and key = ?
   limit 2
)
select session.key as session_key,
       session.document as session_json,
       account.key as account_key,
       account.document as account_json
  from presented_session as session
  left join ${d1AccountsTableNames.documents} as account
    on account.bucket = 'accounts'
   and account.key = json_extract(session.document, '$.subject')
 limit 2`;

const WORKSPACE_BOOTSTRAP_CONTROL_SQL = `with selected_workspace as (
  select id, handle, record_json, created_at, updated_at
    from ${deployControlD1TableNames.workspaces}
   where id = ?
   limit 2
), selected_project as (
  select id, workspace_id, name, slug, record_json, created_at, updated_at
    from ${deployControlD1TableNames.projects}
   where id = ? and workspace_id = ? and slug = '${DEFAULT_PROJECT_SLUG}'
   limit 2
), selected_target_pool as (
  select id, space_id, name, spec_json, created_at, updated_at
    from ${deployControlD1TableNames.targetPools}
   where id = ? and space_id = ? and name = 'default'
   limit 2
)
select workspace.id as workspace_id,
       workspace.handle as workspace_handle,
       workspace.record_json as workspace_record_json,
       workspace.created_at as workspace_created_at,
       workspace.updated_at as workspace_updated_at,
       project.id as project_id,
       project.workspace_id as project_workspace_id,
       project.name as project_name,
       project.slug as project_slug,
       project.record_json as project_record_json,
       project.created_at as project_created_at,
       project.updated_at as project_updated_at,
       target_pool.id as target_pool_id,
       target_pool.space_id as target_pool_space_id,
       target_pool.name as target_pool_name,
       target_pool.spec_json as target_pool_spec_json,
       target_pool.created_at as target_pool_created_at,
       target_pool.updated_at as target_pool_updated_at
  from selected_workspace as workspace
 cross join selected_project as project
 cross join selected_target_pool as target_pool
 limit 2`;

/**
 * Compose the narrow, side-effect-free authority read used by hosted bootstrap.
 * It never constructs an Accounts/Control store or executes schema, cleanup,
 * audit, usage, or other mutation paths.
 */
export function createCloudflareD1WorkspaceBootstrapReader(
  options: CloudflareD1WorkspaceBootstrapReaderOptions,
): WorkspaceBootstrapReader {
  let membershipReader: CloudflareD1PatWorkspaceMembershipReader | undefined;
  try {
    if (
      !options ||
      typeof options.sessionHashSalt !== "string" ||
      options.sessionHashSalt.length === 0 ||
      !options.accountsDb ||
      typeof options.accountsDb.prepare !== "function" ||
      !options.controlDb ||
      typeof options.controlDb.prepare !== "function"
    ) {
      throw new TypeError("Workspace bootstrap reader configuration is invalid");
    }
    membershipReader = createCloudflareD1PatWorkspaceMembershipReader(
      options.controlDb,
    );
  } catch {
    membershipReader = undefined;
  }
  return {
    async read(input) {
      if (!membershipReader) return { status: "unavailable" };
      if (!workspaceBootstrapInputIsCanonical(input)) {
        return { status: "invalid_session" };
      }
      const session = await readAccountsSessionAuthority(options, input);
      if (session.status !== "authenticated") return session;

      let membership: WorkspaceMember | undefined;
      try {
        membership = await membershipReader.getMember(
          input.workspaceId,
          session.subject,
        );
      } catch (error) {
        return membershipReadFailureResult(error);
      }
      if (
        !membership ||
        membership.status !== "active" ||
        !membership.roles.includes("owner")
      ) {
        return { status: "not_owner" };
      }

      const control = await readWorkspaceBootstrapControl(
        options.controlDb,
        input.workspaceId,
        session.subject,
      );
      if (control.status !== "ready") return control;
      return {
        status: "authenticated_owner",
        subject: session.subject,
        workspace: control.workspace,
        membership,
        defaultProject: control.defaultProject,
        defaultTargetPool: control.defaultTargetPool,
      };
    },
  };
}

async function readAccountsSessionAuthority(
  options: CloudflareD1WorkspaceBootstrapReaderOptions,
  input: WorkspaceBootstrapReadInput,
): Promise<
  | { readonly status: "authenticated"; readonly subject: TakosumiSubject }
  | Extract<WorkspaceBootstrapReadResult, { status: "invalid_session" }>
  | Extract<WorkspaceBootstrapReadResult, { status: "incomplete" }>
  | Extract<WorkspaceBootstrapReadResult, { status: "unavailable" }>
> {
  let sessionHash: string;
  let result;
  try {
    sessionHash = await hashSessionIdWithSalt(
      input.sessionId,
      options.sessionHashSalt,
    );
    result = await options.accountsDb
      .prepare(ACCOUNTS_SESSION_AUTHORITY_SQL)
      .bind(sessionHash)
      .all<AccountsSessionAuthorityRow>();
  } catch {
    return { status: "unavailable" };
  }
  if (!result || !result.success || !Array.isArray(result.results)) {
    return { status: "unavailable" };
  }
  if (result.results.length === 0) return { status: "invalid_session" };
  if (result.results.length !== 1) return { status: "incomplete" };
  const row = result.results[0]!;
  if (!row || typeof row !== "object") return { status: "incomplete" };
  if (row.account_key === null && row.account_json === null) {
    return { status: "invalid_session" };
  }
  if (
    row.session_key !== sessionHash ||
    typeof row.session_json !== "string" ||
    typeof row.account_key !== "string" ||
    typeof row.account_json !== "string"
  ) {
    return { status: "incomplete" };
  }
  const session = parseJsonObject(row.session_json);
  const account = parseJsonObject(row.account_json);
  if (!session || !account) return { status: "incomplete" };
  const subject = session.subject;
  if (
    session.sessionId !== sessionHash ||
    !isTakosumiSubject(subject) ||
    !isSafeTimestamp(session.createdAt) ||
    !isSafeTimestamp(session.expiresAt) ||
    row.account_key !== subject ||
    account.subject !== subject ||
    !isSafeTimestamp(account.createdAt) ||
    !isSafeTimestamp(account.updatedAt)
  ) {
    return { status: "incomplete" };
  }
  if ((session.expiresAt as number) <= input.now) {
    return { status: "invalid_session" };
  }
  return { status: "authenticated", subject };
}

async function readWorkspaceBootstrapControl(
  db: ReadOnlyD1Database,
  workspaceId: string,
  subject: TakosumiSubject,
): Promise<
  | {
      readonly status: "ready";
      readonly workspace: Workspace;
      readonly defaultProject: Project;
      readonly defaultTargetPool: PlatformWorkspaceBootstrapTargetPool;
    }
  | { readonly status: "incomplete" }
  | { readonly status: "unavailable" }
> {
  const projectId = defaultProjectId(workspaceId);
  const targetPoolId = formatResourceShapeId(
    workspaceId,
    "TargetPool",
    "default",
  );
  let result;
  try {
    result = await db
      .prepare(WORKSPACE_BOOTSTRAP_CONTROL_SQL)
      .bind(workspaceId, projectId, workspaceId, targetPoolId, workspaceId)
      .all<WorkspaceBootstrapControlRow>();
  } catch {
    return { status: "unavailable" };
  }
  if (!result || result.success !== true || !Array.isArray(result.results)) {
    return { status: "unavailable" };
  }
  if (result.results.length !== 1) return { status: "incomplete" };
  const row = result.results[0]!;
  if (!row || typeof row !== "object") return { status: "incomplete" };
  const workspace = workspaceFromRow(row, workspaceId, subject);
  const project = projectFromRow(row, workspaceId, projectId);
  const targetPool = targetPoolFromRow(row, workspaceId, targetPoolId);
  return workspace && project && targetPool
    ? {
        status: "ready",
        workspace,
        defaultProject: project,
        defaultTargetPool: targetPool,
      }
    : { status: "incomplete" };
}

function membershipReadFailureResult(
  error: unknown,
): Extract<WorkspaceBootstrapReadResult, { status: "incomplete" | "unavailable" }> {
  // The bounded membership reader intentionally exposes only its read port.
  // Preserve malformed/duplicate durable evidence as incomplete while treating
  // failed D1 execution or an unknown reader failure as unavailable.
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("exactly one row") ||
      message.includes("evidence is malformed") ||
      message.includes("evidence identity is invalid")
    ) {
      return { status: "incomplete" };
    }
  }
  return { status: "unavailable" };
}

function workspaceFromRow(
  row: WorkspaceBootstrapControlRow,
  workspaceId: string,
  subject: TakosumiSubject,
): Workspace | undefined {
  if (typeof row.workspace_record_json !== "string") return undefined;
  const value = parseJsonObject(row.workspace_record_json);
  if (
    !value ||
    row.workspace_id !== workspaceId ||
    value.id !== workspaceId ||
    typeof row.workspace_handle !== "string" ||
    row.workspace_handle.length === 0 ||
    value.handle !== row.workspace_handle ||
    typeof value.displayName !== "string" ||
    value.displayName.length === 0 ||
    (value.type !== "personal" && value.type !== "organization") ||
    value.ownerUserId !== subject ||
    !isCanonicalTimestamp(row.workspace_created_at) ||
    !isCanonicalTimestamp(row.workspace_updated_at) ||
    value.createdAt !== row.workspace_created_at ||
    value.updatedAt !== row.workspace_updated_at ||
    (value.archivedAt !== undefined &&
      !isCanonicalTimestamp(value.archivedAt)) ||
    (value.billingSettings !== undefined &&
      !isJsonObject(value.billingSettings)) ||
    (value.policy !== undefined && !isJsonObject(value.policy))
  ) {
    return undefined;
  }
  return value as unknown as Workspace;
}

function projectFromRow(
  row: WorkspaceBootstrapControlRow,
  workspaceId: string,
  projectId: string,
): Project | undefined {
  if (typeof row.project_record_json !== "string") return undefined;
  const value = parseJsonObject(row.project_record_json);
  if (
    !value ||
    row.project_id !== projectId ||
    row.project_workspace_id !== workspaceId ||
    row.project_slug !== DEFAULT_PROJECT_SLUG ||
    typeof row.project_name !== "string" ||
    row.project_name.length === 0 ||
    value.id !== row.project_id ||
    value.workspaceId !== row.project_workspace_id ||
    value.name !== row.project_name ||
    value.slug !== row.project_slug ||
    !isJsonObject(value.projectJson) ||
    !isCanonicalTimestamp(row.project_created_at) ||
    !isCanonicalTimestamp(row.project_updated_at) ||
    value.createdAt !== row.project_created_at ||
    value.updatedAt !== row.project_updated_at
  ) {
    return undefined;
  }
  return value as unknown as Project;
}

function targetPoolFromRow(
  row: WorkspaceBootstrapControlRow,
  workspaceId: string,
  targetPoolId: string,
): PlatformWorkspaceBootstrapTargetPool | undefined {
  if (
    row.target_pool_id !== targetPoolId ||
    row.target_pool_space_id !== workspaceId ||
    row.target_pool_name !== "default" ||
    typeof row.target_pool_spec_json !== "string" ||
    !isCanonicalTimestamp(row.target_pool_created_at) ||
    !isCanonicalTimestamp(row.target_pool_updated_at)
  ) {
    return undefined;
  }
  const spec = parseJsonObject(row.target_pool_spec_json);
  if (!spec) return undefined;
  return {
    id: targetPoolId,
    workspaceId,
    name: "default",
    spec: spec as JsonObject,
    createdAt: row.target_pool_created_at,
    updatedAt: row.target_pool_updated_at,
  };
}

function workspaceBootstrapInputIsCanonical(
  input: WorkspaceBootstrapReadInput,
): boolean {
  return (
    Boolean(input) &&
    canonicalSessionId(input.sessionId) &&
    /^ws_[A-Za-z0-9._~-]+$/u.test(input.workspaceId) &&
    input.workspaceId.length <= 256 &&
    isSafeTimestamp(input.now)
  );
}

function canonicalSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^sess_[A-Za-z0-9._~-]+$/u.test(value)
  );
}

function parseJsonObject(value: string): Record<string, JsonValue> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return isJsonObject(parsed) ? parsed : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function isTakosumiSubject(value: unknown): value is TakosumiSubject {
  return (
    typeof value === "string" &&
    /^tsub_[^\s]+$/u.test(value) &&
    value.length <= 256
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    Number.isFinite(new Date(value as number).getTime())
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
