import { apiFetch, qs } from "./client";

/** A subset of InstallationRecord that the dashboard actually displays.
 *  Mirrors accounts-service/src/ledger.ts InstallationRecord. */
export interface Installation {
  readonly installationId: string;
  readonly appId: string;
  readonly accountId?: string;
  readonly spaceId?: string;
  readonly sourceGitUrl?: string;
  readonly sourceRef?: string;
  readonly sourceCommit?: string;
  readonly planSnapshotDigest?: string;
  readonly artifactDigest?: string;
  readonly mode?: "shared-cell" | "dedicated" | "self-hosted";
  // Aligned with the canonical contract enum
  // (`@takosjp/takosumi-accounts-contract` ->
  // `TakosumiAppInstallationStatus`). Wave 6 removed the legacy
  // `uninstalling` / `uninstalled` / `error` values; the canonical list is
  // `installing` / `ready` / `failed` / `suspended` / `exported`.
  readonly status?:
    | "installing"
    | "ready"
    | "failed"
    | "suspended"
    | "exported";
  readonly launchUrl?: string;
  readonly createdBySubject?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

// ===== Wire shape (what the backend actually returns) =====================
// Backend serializes everything as snake_case (`installation.id`,
// `account_id`, `source: {type, url, ref, commit}`) and wraps detail/create
// responses in an envelope. We translate to the camelCase shape the SPA renders
// so component code stays idiomatic TS.

interface WireInstallation {
  readonly id?: string;
  readonly app_id?: string;
  readonly account_id?: string;
  readonly space_id?: string;
  readonly source?: {
    readonly url?: string;
    readonly ref?: string;
    readonly commit?: string;
  };
  readonly plan_snapshot_digest?: string;
  readonly artifact_digest?: string | null;
  readonly mode?: Installation["mode"];
  readonly status?: Installation["status"];
  readonly launch_url?: string | null;
  readonly launch?: {
    readonly url?: string | null;
  } | null;
  readonly created_by_subject?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

interface InstallationEnvelope {
  readonly installation: WireInstallation;
}

function deserializeInstallation(
  raw: WireInstallation | undefined,
): Installation {
  const r = raw ?? {};
  return {
    installationId: r.id ?? "",
    appId: r.app_id ?? "",
    accountId: r.account_id,
    spaceId: r.space_id,
    sourceGitUrl: r.source?.url,
    sourceRef: r.source?.ref,
    sourceCommit: r.source?.commit,
    planSnapshotDigest: r.plan_snapshot_digest,
    artifactDigest: r.artifact_digest ?? undefined,
    mode: r.mode,
    status: r.status,
    launchUrl: r.launch_url ?? r.launch?.url ?? undefined,
    createdBySubject: r.created_by_subject,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function deserializeEnvelope(env: InstallationEnvelope): Installation {
  return deserializeInstallation(env.installation);
}

// ===== Public API ==========================================================

interface ListResponse {
  readonly installations?: readonly WireInstallation[];
}

/** Backend requires space_id. Caller decides what to show when none is set. */
export async function listInstallationsForSpace(
  spaceId: string,
): Promise<readonly Installation[]> {
  const body = await apiFetch<ListResponse>(
    "/v1/installations" + qs({ space_id: spaceId }),
  );
  return (body.installations ?? []).map(deserializeInstallation);
}

export async function getInstallation(id: string): Promise<Installation> {
  const env = await apiFetch<InstallationEnvelope>(
    `/v1/installations/${encodeURIComponent(id)}`,
  );
  return deserializeEnvelope(env);
}

export interface InstallationDryRunInput {
  readonly gitUrl: string;
  readonly ref: string;
  readonly spaceId: string;
}

/** Installer dry-run shape is provider-controlled; treat as opaque JSON for display. */
export type InstallationDryRunResponse = Record<string, unknown>;

export async function dryRunInstallation(
  input: InstallationDryRunInput,
): Promise<InstallationDryRunResponse> {
  return await apiFetch<InstallationDryRunResponse>(
    "/v1/installations/dry-run",
    {
      method: "POST",
      body: {
        spaceId: input.spaceId,
        source: { kind: "git", url: input.gitUrl, ref: input.ref },
      },
    },
  );
}

export interface CreateInstallationInput {
  readonly accountId: string;
  readonly spaceId: string;
  readonly appId: string;
  readonly source: {
    readonly gitUrl: string;
    readonly ref: string;
    readonly commit: string;
    readonly planSnapshotDigest: string;
    readonly artifactDigest?: string;
  };
  readonly mode: "shared-cell" | "dedicated" | "self-hosted";
  readonly createdBySubject: string;
}

export async function createInstallation(
  input: CreateInstallationInput,
): Promise<Installation> {
  const env = await apiFetch<InstallationEnvelope>("/v1/installations", {
    method: "POST",
    body: input,
  });
  return deserializeEnvelope(env);
}

export async function uninstallInstallation(id: string): Promise<void> {
  await apiFetch<unknown>(`/v1/installations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
