import {
  normalizeIssuer,
  TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import {
  type ServiceBindingMaterialKind,
  type ServiceBindingMaterialRecord,
  type ServiceGrantMaterialRecord,
  type AppInstallationMode,
  type AppInstallationStatus,
  type InstallationEventRecord,
  type InstallationRecord,
  isServiceBindingMaterialKind,
  type RuntimeBindingRecord,
} from "./ledger.ts";
import type { AccountsStore, OidcClientRecord } from "./store.ts";
import { redactPublicRecord } from "./public-redaction.ts";

/**
 * Internal grant capability allowlist used by export bundle validation.
 * Mirrors the internal v0 catalog (v1 contract reset removed grants from the
 * public surface).
 */
const SERVICE_GRANT_MATERIAL_CAPABILITIES = [
  "app.profile.write",
  "app.memory.write",
  "deploy.intent.write",
  "logs.read.own",
  "billing.usage.report",
  "spaces:read",
  "spaces:write",
  "files:read",
  "files:write",
  "memories:read",
  "memories:write",
  "threads:read",
  "threads:write",
  "runs:read",
  "runs:write",
  "agents:execute",
  "repos:read",
  "repos:write",
  "mcp:invoke",
  "events:subscribe",
] as const;

export type JsonObject = Record<string, unknown>;

export interface AccountsInstallationExportBundle {
  readonly kind: typeof TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND;
  readonly version: "v1";
  readonly exportedAt: string;
  readonly installation: {
    readonly installationId: string;
    readonly accountId: string;
    readonly spaceId: string;
    readonly appId: string;
    readonly billingAccountId: string | null;
    readonly mode: AppInstallationMode;
    readonly status: AppInstallationStatus;
  };
  readonly source: {
    readonly gitUrl: string;
    readonly ref: string;
    readonly commit: string;
    readonly planDigest: string;
    readonly artifactDigest: string | null;
  };
  readonly runtimeTarget: ExportRuntimeTarget | null;
  readonly oidcClient: ExportOidcClient | null;
  readonly serviceBindings: readonly ExportServiceBindingTemplate[];
  readonly serviceGrants: readonly ExportServiceGrant[];
  readonly events: readonly ExportEventRef[];
}

export interface ExportRuntimeTarget {
  readonly runtimeTargetId: string;
  readonly mode: AppInstallationMode;
  readonly targetType: RuntimeBindingRecord["targetType"];
  readonly targetId: string;
}

export interface ExportOidcClient {
  readonly clientId: string;
  readonly serviceBinding: string;
  readonly servicePath: string;
  /** Optional stored projection name used by account-plane ledgers. */
  readonly namespacePath?: string;
  readonly issuerUrl: string;
  readonly redirectUris: readonly string[];
  readonly allowedScopes: readonly string[];
  readonly subjectMode: "pairwise";
  readonly tokenEndpointAuthMethod: OidcClientRecord["tokenEndpointAuthMethod"];
}

export interface ExportServiceBindingTemplate {
  readonly serviceBindingId: string;
  readonly name: string;
  readonly kind: ServiceBindingMaterialKind;
  readonly template: {
    readonly configRef: string;
  };
}

export interface ExportServiceGrant {
  readonly serviceGrantId: string;
  readonly capability: ServiceGrantMaterialRecord["capability"];
  readonly scope: JsonObject;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

export interface ExportEventRef {
  readonly eventId: string;
  readonly type: string;
  readonly eventHash: string;
  readonly createdAt: string;
}

export interface BuildInstallationExportBundleInput {
  readonly installation: InstallationRecord;
  readonly runtimeBinding?: RuntimeBindingRecord;
  readonly bindings?: readonly ServiceBindingMaterialRecord[];
  readonly grants?: readonly ServiceGrantMaterialRecord[];
  readonly oidcClient?: OidcClientRecord;
  readonly events?: readonly InstallationEventRecord[];
  readonly exportedAt?: string;
}

export interface PlanInstallationImportInput {
  readonly bundle: AccountsInstallationExportBundle;
  readonly targetIssuer: string;
  readonly targetAccountId: string;
  readonly targetSpaceId: string;
  readonly createdBySubject: TakosumiSubject;
  readonly targetInstallationId?: string;
  readonly mode?: Extract<AppInstallationMode, "dedicated" | "self-hosted">;
}

export interface InstallationImportPlan {
  readonly kind: "takosumi.accounts.installation-import-plan@v1";
  readonly bundleKind: typeof TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND;
  readonly sourceIssuer: string | null;
  readonly targetIssuer: string;
  readonly request: JsonObject;
}

export interface CollectInstallationExportBundleInput {
  readonly store: AccountsStore;
  readonly installationId: string;
  readonly exportedAt?: string;
}

export async function collectInstallationExportBundle(
  input: CollectInstallationExportBundleInput,
): Promise<AccountsInstallationExportBundle | undefined> {
  const installation = await input.store.findAppInstallation(
    input.installationId,
  );
  if (!installation) return undefined;
  const runtimeBinding = installation.runtimeBindingId
    ? await input.store.findRuntimeBinding(installation.runtimeBindingId)
    : undefined;
  const bindings = await input.store.listServiceBindingMaterialsForInstallation(
    input.installationId,
  );
  const grants = await input.store.listServiceGrantMaterialsForInstallation(
    input.installationId,
  );
  const oidcClient = await input.store.findOidcClientForInstallation(
    input.installationId,
  );
  const events = await input.store.listInstallationEvents(input.installationId);
  return buildInstallationExportBundle({
    installation,
    runtimeBinding,
    bindings,
    grants,
    oidcClient,
    events,
    exportedAt: input.exportedAt,
  });
}

export function buildInstallationExportBundle(
  input: BuildInstallationExportBundleInput,
): AccountsInstallationExportBundle {
  return {
    kind: TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
    version: "v1",
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    installation: {
      installationId: input.installation.installationId,
      accountId: input.installation.accountId,
      spaceId: input.installation.spaceId,
      appId: input.installation.appId,
      billingAccountId: input.installation.billingAccountId ?? null,
      mode: input.installation.mode,
      status: input.installation.status,
    },
    source: {
      gitUrl: input.installation.sourceGitUrl,
      ref: input.installation.sourceRef,
      commit: input.installation.sourceCommit,
      planDigest: input.installation.planDigest,
      artifactDigest: input.installation.artifactDigest ?? null,
    },
    runtimeTarget: input.runtimeBinding
      ? {
          runtimeTargetId: input.runtimeBinding.runtimeBindingId,
          mode: input.runtimeBinding.mode,
          targetType: input.runtimeBinding.targetType,
          targetId: input.runtimeBinding.targetId,
        }
      : null,
    oidcClient: input.oidcClient
      ? {
          clientId: input.oidcClient.clientId,
          serviceBinding: oidcServiceBindingName(input.bindings ?? []),
          servicePath: input.oidcClient.namespacePath,
          issuerUrl: input.oidcClient.issuerUrl,
          redirectUris: [...input.oidcClient.redirectUris],
          allowedScopes: [...input.oidcClient.allowedScopes],
          subjectMode: input.oidcClient.subjectMode,
          tokenEndpointAuthMethod: input.oidcClient.tokenEndpointAuthMethod,
        }
      : null,
    serviceBindings: [...(input.bindings ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((binding) => ({
        serviceBindingId: binding.bindingId,
        name: binding.name,
        kind: binding.kind,
        template: {
          configRef: binding.configRef,
        },
      })),
    serviceGrants: [...(input.grants ?? [])]
      .sort((a, b) => a.grantId.localeCompare(b.grantId))
      .map((grant) => ({
        serviceGrantId: grant.grantId,
        capability: grant.capability,
        scope: redactPublicRecord(grant.scope),
        grantedAt: new Date(grant.grantedAt).toISOString(),
        revokedAt: grant.revokedAt
          ? new Date(grant.revokedAt).toISOString()
          : null,
      })),
    events: [...(input.events ?? [])]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((event) => ({
        eventId: event.eventId,
        type: event.eventType,
        eventHash: event.eventHash,
        createdAt: new Date(event.createdAt).toISOString(),
      })),
  };
}

export function planInstallationImport(
  input: PlanInstallationImportInput,
): InstallationImportPlan {
  if (input.bundle.kind !== TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND) {
    throw new TypeError("unsupported installation export bundle kind");
  }
  const targetIssuer = normalizeIssuer(input.targetIssuer);
  const sourceIssuer = input.bundle.oidcClient
    ? normalizeIssuer(input.bundle.oidcClient.issuerUrl)
    : null;
  const targetInstallationId =
    input.targetInstallationId ?? input.bundle.installation.installationId;
  const rewrite = (value: unknown): unknown =>
    sourceIssuer ? rewriteIssuer(value, sourceIssuer, targetIssuer) : value;
  const oidcClient = input.bundle.oidcClient;

  return {
    kind: "takosumi.accounts.installation-import-plan@v1",
    bundleKind: TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
    sourceIssuer,
    targetIssuer,
    request: {
      installationId: targetInstallationId,
      accountId: input.targetAccountId,
      spaceId: input.targetSpaceId,
      appId: input.bundle.installation.appId,
      source: {
        gitUrl: input.bundle.source.gitUrl,
        ref: input.bundle.source.ref,
        commit: input.bundle.source.commit,
        planDigest: input.bundle.source.planDigest,
        artifactDigest: input.bundle.source.artifactDigest,
      },
      mode: input.mode ?? "self-hosted",
      status: "installing",
      createdBySubject: input.createdBySubject,
      serviceBindings: input.bundle.serviceBindings.map((serviceBinding) => ({
        serviceBindingId: `bind_${targetInstallationId}_${serviceBinding.name}`,
        name: serviceBinding.name,
        kind: serviceBinding.kind,
        configRef: importServiceBindingTemplateRef({
          installationId: targetInstallationId,
          serviceBinding: serviceBinding.name,
          kind: serviceBinding.kind,
        }),
        declaration: {
          exportTemplate: rewrite(serviceBinding.template),
          sourceServiceBindingId: serviceBinding.serviceBindingId,
        },
      })),
      serviceGrants: input.bundle.serviceGrants
        .filter((serviceGrant) => !serviceGrant.revokedAt)
        .map((serviceGrant) => ({
          serviceGrantId: serviceGrant.serviceGrantId,
          capability: serviceGrant.capability,
          scope: redactPublicRecord(serviceGrant.scope),
        })),
      ...(oidcClient
        ? {
            oidcClients: [
              {
                serviceBinding: oidcClient.serviceBinding,
                servicePath: oidcServicePath(oidcClient),
                issuerUrl: targetIssuer,
                redirectUris: rewrite(oidcClient.redirectUris),
                allowedScopes: oidcClient.allowedScopes,
                subjectMode: oidcClient.subjectMode,
                tokenEndpointAuthMethod: oidcClient.tokenEndpointAuthMethod,
              },
            ],
          }
        : {}),
    },
  };
}

function oidcServicePath(oidcClient: {
  readonly servicePath?: string;
  readonly namespacePath?: string;
}): string {
  return (
    oidcClient.servicePath ??
    oidcClient.namespacePath ??
    "takosumi.identity.oidc"
  );
}

function oidcServiceBindingName(
  bindings: readonly ServiceBindingMaterialRecord[],
): string {
  return (
    bindings.find((binding) => binding.kind === "identity.oidc")?.name ?? "auth"
  );
}

function rewriteIssuer(
  value: unknown,
  sourceIssuer: string,
  targetIssuer: string,
): unknown {
  if (typeof value === "string") {
    return rewriteIssuerString(value, sourceIssuer, targetIssuer);
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      rewriteIssuer(entry, sourceIssuer, targetIssuer),
    );
  }
  if (isRecord(value)) {
    const output: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = rewriteIssuer(entry, sourceIssuer, targetIssuer);
    }
    return output;
  }
  return value;
}

/**
 * Origin-aware issuer rewrite. `sourceIssuer`/`targetIssuer` are normalized
 * origins (e.g. `https://acc.example`). A blind `split(sourceIssuer).join(...)`
 * is unsafe because the source origin can be a leading substring of an
 * unrelated host (e.g. `https://acc.example.evil.com/...`), which would mangle
 * that URL. Instead we parse the candidate as a URL and rewrite only when its
 * origin exactly equals the source origin, replacing just the origin component
 * and preserving path/query/hash. Non-URL strings are left untouched.
 */
function rewriteIssuerString(
  value: string,
  sourceIssuer: string,
  targetIssuer: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.origin !== sourceIssuer) return value;
  return `${targetIssuer}${value.slice(url.origin.length)}`;
}

function importServiceBindingTemplateRef(input: {
  installationId: string;
  serviceBinding: string;
  kind: ServiceBindingMaterialKind;
}): string {
  return `takosumi-import://installations/${encodeURIComponent(
    input.installationId,
  )}/service-bindings/${encodeURIComponent(input.serviceBinding)}/${encodeURIComponent(
    input.kind,
  )}`;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INSTALLATION_MODES: readonly AppInstallationMode[] = [
  "shared-cell",
  "dedicated",
  "self-hosted",
];

const INSTALLATION_STATUSES: readonly AppInstallationStatus[] = [
  "installing",
  "ready",
  "failed",
  "suspended",
  "exported",
];

const RUNTIME_BINDING_TARGET_TYPES: readonly RuntimeBindingRecord["targetType"][] =
  ["shared-cell", "dedicated", "self-hosted"];

const TOKEN_AUTH_METHODS: readonly OidcClientRecord["tokenEndpointAuthMethod"][] =
  ["client_secret_basic", "client_secret_post", "none"];

/**
 * Validate an unknown value against the `AccountsInstallationExportBundle`
 * shape and return the typed bundle.
 *
 * Throws `TypeError` with a path-prefixed message on the first invalid field
 * so HTTP handlers can surface the failure as a 400 response.
 */
export function parseAccountsInstallationExportBundle(
  value: unknown,
): AccountsInstallationExportBundle {
  const bundle = requireRecord(value, "bundle");
  if (bundle.kind !== TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND) {
    throw new TypeError(
      `bundle.kind must be ${TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND}`,
    );
  }
  if (bundle.version !== "v1") {
    throw new TypeError(`bundle.version must be "v1"`);
  }
  return {
    kind: TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
    version: "v1",
    exportedAt: requireString(bundle.exportedAt, "bundle.exportedAt"),
    installation: parseInstallationFields(bundle.installation),
    source: parseSourceFields(bundle.source),
    runtimeTarget: parseExportRuntimeTarget(bundle.runtimeTarget),
    oidcClient: parseExportOidcClient(bundle.oidcClient),
    serviceBindings: parseExportServiceBindings(bundle.serviceBindings),
    serviceGrants: parseExportServiceGrants(bundle.serviceGrants),
    events: parseExportEvents(bundle.events),
  };
}

function parseInstallationFields(
  value: unknown,
): AccountsInstallationExportBundle["installation"] {
  const record = requireRecord(value, "bundle.installation");
  return {
    installationId: requireString(
      record.installationId,
      "bundle.installation.installationId",
    ),
    accountId: requireString(record.accountId, "bundle.installation.accountId"),
    spaceId: requireString(record.spaceId, "bundle.installation.spaceId"),
    appId: requireString(record.appId, "bundle.installation.appId"),
    billingAccountId: parseNullableString(
      record.billingAccountId,
      "bundle.installation.billingAccountId",
    ),
    mode: requireEnum(
      record.mode,
      INSTALLATION_MODES,
      "bundle.installation.mode",
    ),
    status: requireEnum(
      record.status,
      INSTALLATION_STATUSES,
      "bundle.installation.status",
    ),
  };
}

function parseSourceFields(
  value: unknown,
): AccountsInstallationExportBundle["source"] {
  const record = requireRecord(value, "bundle.source");
  return {
    gitUrl: requireString(record.gitUrl, "bundle.source.gitUrl"),
    ref: requireString(record.ref, "bundle.source.ref"),
    commit: requireString(record.commit, "bundle.source.commit"),
    planDigest: requireString(record.planDigest, "bundle.source.planDigest"),
    artifactDigest: parseNullableString(
      record.artifactDigest,
      "bundle.source.artifactDigest",
    ),
  };
}

function parseExportRuntimeTarget(value: unknown): ExportRuntimeTarget | null {
  if (value === null) return null;
  const record = requireRecord(value, "bundle.runtimeTarget");
  return {
    runtimeTargetId: requireString(
      record.runtimeTargetId,
      "bundle.runtimeTarget.runtimeTargetId",
    ),
    mode: requireEnum(
      record.mode,
      INSTALLATION_MODES,
      "bundle.runtimeTarget.mode",
    ),
    targetType: requireEnum(
      record.targetType,
      RUNTIME_BINDING_TARGET_TYPES,
      "bundle.runtimeTarget.targetType",
    ),
    targetId: requireString(record.targetId, "bundle.runtimeTarget.targetId"),
  };
}

function parseExportOidcClient(value: unknown): ExportOidcClient | null {
  if (value === null) return null;
  const record = requireRecord(value, "bundle.oidcClient");
  const subjectMode = record.subjectMode;
  if (subjectMode !== "pairwise") {
    throw new TypeError(`bundle.oidcClient.subjectMode must be "pairwise"`);
  }
  const servicePath = requireString(
    record.servicePath ?? record.namespacePath,
    "bundle.oidcClient.servicePath",
  );
  return {
    clientId: requireString(record.clientId, "bundle.oidcClient.clientId"),
    serviceBinding: requireString(
      record.serviceBinding,
      "bundle.oidcClient.serviceBinding",
    ),
    servicePath,
    ...(typeof record.namespacePath === "string" &&
    record.namespacePath.length > 0
      ? { namespacePath: record.namespacePath }
      : {}),
    issuerUrl: requireString(record.issuerUrl, "bundle.oidcClient.issuerUrl"),
    redirectUris: requireStringArray(
      record.redirectUris,
      "bundle.oidcClient.redirectUris",
    ),
    allowedScopes: requireStringArray(
      record.allowedScopes,
      "bundle.oidcClient.allowedScopes",
    ),
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: requireEnum(
      record.tokenEndpointAuthMethod,
      TOKEN_AUTH_METHODS,
      "bundle.oidcClient.tokenEndpointAuthMethod",
    ),
  };
}

function parseExportServiceBindings(
  value: unknown,
): readonly ExportServiceBindingTemplate[] {
  const items = requireArray(value, "bundle.serviceBindings");
  return items.map((entry, index) => {
    const record = requireRecord(entry, `bundle.serviceBindings[${index}]`);
    const template = requireRecord(
      record.template,
      `bundle.serviceBindings[${index}].template`,
    );
    const kind = record.kind;
    if (!isServiceBindingMaterialKind(kind)) {
      throw new TypeError(
        `bundle.serviceBindings[${index}].kind is not a recognized service binding kind`,
      );
    }
    return {
      serviceBindingId: requireString(
        record.serviceBindingId,
        `bundle.serviceBindings[${index}].serviceBindingId`,
      ),
      name: requireString(record.name, `bundle.serviceBindings[${index}].name`),
      kind,
      template: {
        configRef: requireString(
          template.configRef,
          `bundle.serviceBindings[${index}].template.configRef`,
        ),
      },
    };
  });
}

function parseExportServiceGrants(
  value: unknown,
): readonly ExportServiceGrant[] {
  const items = requireArray(value, "bundle.serviceGrants");
  return items.map((entry, index) => {
    const record = requireRecord(entry, `bundle.serviceGrants[${index}]`);
    const capability = record.capability;
    if (
      typeof capability !== "string" ||
      !(SERVICE_GRANT_MATERIAL_CAPABILITIES as readonly string[]).includes(
        capability,
      )
    ) {
      throw new TypeError(
        `bundle.serviceGrants[${index}].capability is not a recognized capability`,
      );
    }
    const scope = record.scope;
    if (!isRecord(scope)) {
      throw new TypeError(
        `bundle.serviceGrants[${index}].scope must be an object`,
      );
    }
    return {
      serviceGrantId: requireString(
        record.serviceGrantId,
        `bundle.serviceGrants[${index}].serviceGrantId`,
      ),
      capability: capability as ExportServiceGrant["capability"],
      scope: redactPublicRecord(scope),
      grantedAt: requireString(
        record.grantedAt,
        `bundle.serviceGrants[${index}].grantedAt`,
      ),
      revokedAt: parseNullableString(
        record.revokedAt,
        `bundle.serviceGrants[${index}].revokedAt`,
      ),
    };
  });
}

function parseExportEvents(value: unknown): readonly ExportEventRef[] {
  const items = requireArray(value, "bundle.events");
  return items.map((entry, index) => {
    const record = requireRecord(entry, `bundle.events[${index}]`);
    return {
      eventId: requireString(record.eventId, `bundle.events[${index}].eventId`),
      type: requireString(record.type, `bundle.events[${index}].type`),
      eventHash: requireString(
        record.eventHash,
        `bundle.events[${index}].eventHash`,
      ),
      createdAt: requireString(
        record.createdAt,
        `bundle.events[${index}].createdAt`,
      ),
    };
  });
}

function requireRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  const items = requireArray(value, label);
  return items.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TypeError(`${label}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw new TypeError(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string or null`);
  }
  return value;
}
