/**
 * Create / import installation lifecycle routes.
 *
 * Pure-move decomposition of the former installation-lifecycle-routes
 * god-file; behavior is identical to the prior single-file handlers.
 */
import {
  takosumiAccountsInstallationEventsPath,
  takosumiAccountsInstallationPath,
} from "@takosjp/takosumi-accounts-contract";
import {
  type ServiceBindingMaterialKind,
  type ServiceBindingMaterialRecord,
  type ServiceGrantMaterialRecord,
  type InstallationRecord,
  type SpaceKind,
  assertValidServiceBindingMaterialRecord,
} from "./ledger.ts";
import type { AccountsStore, OidcClientRecord } from "./store.ts";
import type { SharedCellRuntimeAllocator } from "./runtime.ts";
import {
  appInstallationPermissionDigest,
  installationActivatedHttpDomainEvent,
  installationEnvelope,
  isMeteredBindingKind,
  isSha256DigestRef,
} from "./installation-helpers.ts";
import { runtimeBindingFromValue } from "./installation-materialize-helpers.ts";
import {
  hasRemovedOidcNamespaceAlias,
  oidcAllowedScopesValue,
  oidcClientAuthMethodValue,
  oidcIssuerUrlValue,
  oidcNamespacePathValue,
  oidcRedirectUrisValue,
} from "./installation-routes-internal.ts";
import {
  errorJson,
  appInstallationStatusValue,
  booleanValue,
  isRecord,
  json,
  readJsonObject,
  stringValue,
  takosumiSubjectValue,
} from "./http-helpers.ts";
import type {
  ServiceBindingMaterializationResult,
  ServiceBindingMaterializer,
  LaunchTokenOptions,
} from "./mod.ts";
import type { DeployControlFacadeOptions } from "./deploy-control-facade.ts";
import { appendLedgerEvent } from "./installation-ledger-events.ts";
import {
  type AppInstallationConfirmRecord,
  activatedHttpDomainEventPayload,
  serviceBindingMaterialRecordsFromValue,
  serviceGrantMaterialRecordsFromValue,
  appInstallationModeValue,
  applyCoreInstallationForCloudProjection,
} from "./installation-lifecycle-shared.ts";
import { consoleErrorRedacted } from "./redacted-log.ts";

const PUBLIC_SERVICE_BINDING_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_BEARING_SERVICE_BINDING_ENV_NAME_PATTERN =
  /(^|_)(SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|APIKEY|API_KEY|ACCESSKEY|ACCESS_KEY|PRIVATEKEY|PRIVATE_KEY|CLIENT_SECRET|REFRESH_TOKEN|SESSION_TOKEN|AUTH_TOKEN|BEARER_TOKEN)(_|$)/;
const SECRET_BEARING_SERVICE_BINDING_ENV_EXACT_NAMES = new Set([
  "DATABASE_URL",
  "DB_URL",
  "DSN",
  "CONNECTION_STRING",
]);
const SECRET_BEARING_SERVICE_BINDING_ENV_SUFFIXES = [
  "_DATABASE_URL",
  "_DB_URL",
  "_DSN",
  "_CONNECTION_STRING",
];
const SECRET_BEARING_SERVICE_BINDING_ENV_VALUE_PATTERN =
  /\b(?:Bearer|Basic|Digest|Token)\s+[-._~+/=a-zA-Z0-9]+|\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)=/i;

export async function handleCreateAppInstallation(input: {
  request: Request;
  store: AccountsStore;
  issuer: string;
  deployControl?: DeployControlFacadeOptions;
  launchTokens?: LaunchTokenOptions;
  bindingMaterializer?: ServiceBindingMaterializer;
  sharedCellRuntime?: SharedCellRuntimeAllocator;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return errorJson("invalid_request", "invalid request", 400);
  if (!input.deployControl) {
    return errorJson(
      "deploy_control_required",
      "Installation projection creation requires the Takosumi deploy-control ledger.",
      503,
    );
  }

  const source = isRecord(body.source) ? body.source : {};
  const expected = isRecord(body.expected) ? body.expected : undefined;
  const now = Date.now();
  const requestedInstallationId = stringValue(body.installationId);
  const accountId = stringValue(body.accountId);
  const spaceId = stringValue(body.spaceId);
  let appId = stringValue(body.appId);
  let sourceGitUrl = stringValue(source.gitUrl) ?? stringValue(source.url);
  let sourceRef = stringValue(source.ref);
  let sourceCommit =
    stringValue(expected?.sourceCommit) ?? stringValue(source.commit);
  let sourcePath = stringValue(source.path) ?? stringValue(source.modulePath);
  let planDigest =
    stringValue(expected?.planDigest) ??
    stringValue(source.planDigest) ??
    stringValue(body.planDigest);
  let artifactDigest =
    stringValue(expected?.planArtifactDigest) ??
    stringValue(source.artifactDigest) ??
    stringValue(body.artifactDigest);
  const planRunId =
    stringValue(source.planRunId) ??
    stringValue(body.planRunId) ??
    stringValue(body.plan_run_id) ??
    stringValue(expected?.planRunId);
  const mode = appInstallationModeValue(body.mode);
  const billingAccountId = stringValue(
    body.billingAccountId ?? body.billing_account_id,
  );
  const createdBySubject = takosumiSubjectValue(body.createdBySubject);
  if (!accountId || !spaceId || !mode || !createdBySubject) {
    return errorJson(
      "invalid_request",
      "accountId, spaceId, mode, and createdBySubject are required",
      400,
    );
  }
  const billingGuard = await assertBillingAllowsInstallationCreate({
    store: input.store,
    accountId,
    billingAccountId,
    plan: stringValue(body.plan) ?? stringValue(body.planCode),
    mode,
  });
  if (billingGuard) return billingGuard;
  const existingSpace = await input.store.findSpace(spaceId);
  if (existingSpace && existingSpace.accountId !== accountId) {
    return errorJson("space_account_mismatch", "space account mismatch", 409);
  }
  if (requestedInstallationId) {
    return errorJson(
      "invalid_request",
      "installationId is assigned by Takosumi deploy control for this Accounts facade",
      400,
    );
  }
  if (!expected) {
    return errorJson(
      "invalid_request",
      "installation apply through Takosumi deploy control requires expected review guards",
      400,
    );
  }
  if (
    (planDigest !== undefined && !isSha256DigestRef(planDigest)) ||
    (artifactDigest !== undefined && !isSha256DigestRef(artifactDigest))
  ) {
    return errorJson(
      "invalid_request",
      "source.planDigest and source.artifactDigest must be sha256: digest references",
      400,
    );
  }
  const preflightBindings = serviceBindingMaterialRecordsFromValue({
    value: body.serviceBindings,
    installationId: "inst_core_apply_preflight",
    now,
  });
  if (preflightBindings instanceof Response) return preflightBindings;
  const preflightGrants = serviceGrantMaterialRecordsFromValue({
    value: body.serviceGrants,
    installationId: "inst_core_apply_preflight",
    now,
  });
  if (preflightGrants instanceof Response) return preflightGrants;
  const preflightConfirm = await appInstallationConfirmFromValue({
    value: body.confirm,
    bindings: preflightBindings,
    grants: preflightGrants,
  });
  if (preflightConfirm instanceof Response) return preflightConfirm;
  const preflightOidcClient = await oidcClientCreateRequestFromValue({
    value: body.oidcClients ?? body.oidcClient,
    installationId: "inst_core_apply_preflight",
    defaultIssuer: input.issuer,
    now,
  });
  if (preflightOidcClient instanceof Response) return preflightOidcClient;
  const coreApply = await applyCoreInstallationForCloudProjection({
    deployControl: input.deployControl,
    appId,
    spaceId,
    source,
    expected,
    planRunId,
  });
  if (coreApply instanceof Response) return coreApply;
  appId = coreApply.appId;
  sourceGitUrl = coreApply.sourceUrl;
  sourceRef = coreApply.sourceRef;
  sourceCommit = coreApply.sourceCommit ?? coreApply.sourceDigest;
  sourcePath = coreApply.sourcePath ?? sourcePath;
  planDigest = coreApply.planDigest;
  artifactDigest = coreApply.artifactDigest;
  const installationId = coreApply.installationId;
  // Deploy-control assigns the canonical Installation id. The projection row is
  // a secondary accounts-plane view and must not overwrite another projection.
  if (await input.store.findAppInstallation(installationId)) {
    return errorJson(
      "installation_already_exists",
      "installation already exists",
      409,
    );
  }
  if (
    !accountId ||
    !spaceId ||
    !appId ||
    !sourceGitUrl ||
    !sourceRef ||
    !sourceCommit ||
    !planDigest ||
    !mode ||
    !createdBySubject
  ) {
    return errorJson(
      "invalid_request",
      "accountId, spaceId, appId, source.gitUrl/url, source.ref, source.commit, source.planDigest, mode, and createdBySubject are required",
      400,
    );
  }
  // These fields are digest-typed integrity attestations recorded in the
  // ledger (surfaced as plan_digest); reject values that are not a
  // `sha256:`-prefixed digest reference so the provenance the ledger claims is
  // not weakened by arbitrary junk strings.
  if (
    !isSha256DigestRef(planDigest) ||
    (artifactDigest !== undefined && !isSha256DigestRef(artifactDigest))
  ) {
    return errorJson(
      "invalid_request",
      "source.planDigest and source.artifactDigest must be sha256: digest references",
      400,
    );
  }

  const status = coreApply
    ? "ready"
    : (appInstallationStatusValue(body.status) ?? "installing");
  let runtimeBinding = runtimeBindingFromValue({
    value: body.runtimeTarget,
    installationId,
    mode,
    now,
  });
  let runtimeBindingAutoAssigned = false;
  if (!runtimeBinding && mode === "shared-cell" && input.sharedCellRuntime) {
    runtimeBinding = await input.sharedCellRuntime({
      installationId,
      accountId,
      spaceId,
      appId,
      createdBySubject,
      now,
    });
    if (!runtimeBinding) {
      return errorJson(
        "shared_cell_capacity_unavailable",
        "shared-cell install requires an available warm runtime slot",
        503,
      );
    }
    if (
      runtimeBinding.installationId !== installationId ||
      runtimeBinding.mode !== "shared-cell" ||
      runtimeBinding.targetType !== "shared-cell"
    ) {
      return errorJson(
        "invalid_shared_cell_runtime_target",
        "shared-cell runtime allocator must return a shared-cell runtime target for the requested installation",
        500,
      );
    }
    runtimeBindingAutoAssigned = true;
  }
  const runtimeBindingId =
    runtimeBinding?.runtimeBindingId ?? stringValue(body.runtimeTargetId);
  const bindingsResult = serviceBindingMaterialRecordsFromValue({
    value: body.serviceBindings,
    installationId,
    now,
  });
  if (bindingsResult instanceof Response) return bindingsResult;
  const bindingDeclarations = serviceBindingMaterialDeclarationsFromValue(
    body.serviceBindings,
  );
  if (bindingDeclarations instanceof Response) return bindingDeclarations;
  const grantsResult = serviceGrantMaterialRecordsFromValue({
    value: body.serviceGrants,
    installationId,
    now,
  });
  if (grantsResult instanceof Response) return grantsResult;
  const confirmResult = await appInstallationConfirmFromValue({
    value: body.confirm,
    bindings: bindingsResult,
    grants: grantsResult,
  });
  if (confirmResult instanceof Response) return confirmResult;
  const oidcClientResult = await oidcClientCreateRequestFromValue({
    value: body.oidcClients ?? body.oidcClient,
    installationId,
    defaultIssuer: input.issuer,
    now,
  });
  if (oidcClientResult instanceof Response) return oidcClientResult;
  const bindings = materializeOidcClientBinding({
    bindings: bindingsResult,
    oidcClient: oidcClientResult,
    installationId,
    now,
  });
  if (bindings instanceof Response) return bindings;
  const launchTokenMaterialization = materializeLaunchTokenBindings({
    bindings,
    launchTokens: input.launchTokens,
    installationId,
    now,
  });
  if (launchTokenMaterialization instanceof Response) {
    return launchTokenMaterialization;
  }

  // Opportunistic LedgerAccount create with a check-and-set guard. Two
  // concurrent installs that claim the same accountId could otherwise both
  // pass the existence check and either overwrite the row or race the
  // creation. We:
  //   1. Resolve the existing row (if any) and reject 409 immediately when
  //      the requester's subject does not match the recorded owner.
  //   2. Persist the new row only when no record exists, then read it back
  //      to confirm we are the legal owner. If someone else won the race we
  //      respond 409 instead of silently re-binding the account to them.
  const existingLedgerAccount = await input.store.findLedgerAccount(accountId);
  if (existingLedgerAccount) {
    if (existingLedgerAccount.legalOwnerSubject !== createdBySubject) {
      return errorJson(
        "account_claim_conflict",
        "accountId is already owned by a different Takosumi subject",
        409,
      );
    }
  } else {
    await input.store.saveLedgerAccount({
      accountId,
      legalOwnerSubject: createdBySubject,
      billingAccountId,
      createdAt: now,
      updatedAt: now,
    });
    const confirmedLedgerAccount =
      await input.store.findLedgerAccount(accountId);
    if (
      !confirmedLedgerAccount ||
      confirmedLedgerAccount.legalOwnerSubject !== createdBySubject
    ) {
      return errorJson(
        "account_claim_conflict",
        "accountId was claimed by another install while creating this one",
        409,
      );
    }
  }
  if (!existingSpace) {
    await input.store.saveSpace({
      spaceId,
      accountId,
      kind: spaceKindValue(body.spaceKind) ?? "personal",
      displayName: stringValue(body.spaceDisplayName),
      createdAt: now,
      updatedAt: now,
    });
    // Read-back guard mirroring the LedgerAccount claim check above. The store's
    // ON CONFLICT(space_id) DO UPDATE SET account_id would otherwise let a
    // concurrent create with the same spaceId but a different accountId silently
    // re-own this space, leaving this installation pointing at a space owned by
    // another account.
    const confirmedSpace = await input.store.findSpace(spaceId);
    if (!confirmedSpace || confirmedSpace.accountId !== accountId) {
      return errorJson(
        "space_claim_conflict",
        "spaceId was claimed by another account while creating this one",
        409,
      );
    }
  }

  const installation: InstallationRecord = {
    installationId,
    accountId,
    spaceId,
    appId,
    sourceGitUrl,
    sourceRef,
    sourceCommit,
    ...(sourcePath ? { sourcePath } : {}),
    planDigest,
    artifactDigest,
    mode,
    runtimeBindingId,
    billingAccountId,
    status,
    createdBySubject,
    createdAt: now,
    updatedAt: now,
  };
  const bindingMaterialization =
    await materializeConfiguredServiceBindingMaterials({
      bindings: launchTokenMaterialization.bindings,
      declarations: bindingDeclarations,
      materializer: input.bindingMaterializer,
      installation,
      issuer: input.issuer,
      now,
    });
  if (bindingMaterialization instanceof Response) return bindingMaterialization;
  await input.store.saveAppInstallation(installation);
  if (runtimeBinding) await input.store.saveRuntimeBinding(runtimeBinding);
  for (const binding of bindingMaterialization.bindings) {
    await input.store.saveServiceBindingMaterial(binding);
  }
  for (const grant of grantsResult) {
    await input.store.saveServiceGrantMaterial(grant);
  }
  if (oidcClientResult) {
    await input.store.saveOidcClient(oidcClientResult.client);
  }
  await appendLedgerEvent(input.store, {
    installationId,
    eventType: "installation.created",
    payload: {
      appId,
      accountId,
      spaceId,
      mode,
      status,
      ...(billingAccountId ? { billingAccountId } : {}),
    },
    now,
  });
  if (coreApply?.activatedHttpDomain) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: installationActivatedHttpDomainEvent,
      payload: activatedHttpDomainEventPayload(coreApply.activatedHttpDomain),
      now,
    });
  }
  if (confirmResult) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "installation.approved",
      payload: {
        permissionDigest: confirmResult.permissionDigest,
        costAck: confirmResult.costAck,
        ...(confirmResult.approvalRequired !== undefined
          ? { approvalRequired: confirmResult.approvalRequired }
          : {}),
        ...(confirmResult.expiresAt
          ? { expiresAt: confirmResult.expiresAt }
          : {}),
      },
      now,
    });
  }
  if (oidcClientResult) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "oidc_client.registered",
      payload: {
        clientId: oidcClientResult.client.clientId,
        servicePath: oidcClientResult.client.namespacePath,
        // Existing ledger readers may still read namespacePath in old events.
        namespacePath: oidcClientResult.client.namespacePath,
        issuerUrl: oidcClientResult.client.issuerUrl,
        redirectUris: oidcClientResult.client.redirectUris,
        allowedScopes: oidcClientResult.client.allowedScopes,
        subjectMode: oidcClientResult.client.subjectMode,
        tokenEndpointAuthMethod:
          oidcClientResult.client.tokenEndpointAuthMethod,
      },
      now,
    });
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "service_binding.materialized",
      payload: {
        serviceBinding: oidcClientResult.binding,
        kind: "identity.oidc",
        configRef: oidcBindingConfigRef({
          installationId,
          binding: oidcClientResult.binding,
          clientId: oidcClientResult.client.clientId,
        }),
        secretRefs: [],
      },
      now,
    });
  }
  if (runtimeBindingAutoAssigned && runtimeBinding) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "runtime_target.assigned",
      payload: {
        runtimeTargetId: runtimeBinding.runtimeBindingId,
        mode: runtimeBinding.mode,
        targetType: runtimeBinding.targetType,
        targetId: runtimeBinding.targetId,
      },
      now,
    });
  }
  for (const binding of launchTokenMaterialization.materialized) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "service_binding.materialized",
      payload: {
        serviceBinding: binding.name,
        kind: "auth.bootstrap_token",
        configRef: binding.configRef,
        secretRefs: [],
      },
      now,
    });
  }
  for (const binding of bindingMaterialization.materialized) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "service_binding.materialized",
      payload: {
        serviceBinding: binding.name,
        kind: binding.kind,
        configRef: binding.configRef,
        secretRefs: binding.secretRefs,
      },
      now,
    });
  }

  const envelope = installationEnvelope({
    installation,
    bindings: bindingMaterialization.bindings,
    grants: grantsResult,
    runtimeBinding,
    oidcClient: oidcClientResult?.client,
    activatedHttpDomain: coreApply?.activatedHttpDomain,
    eventsUrl: takosumiAccountsInstallationEventsPath(installationId),
  });
  return json(
    {
      ...envelope,
      ...(Object.keys(bindingMaterialization.env).length > 0
        ? { service_binding_env: bindingMaterialization.env }
        : {}),
    },
    202,
    {
      location: takosumiAccountsInstallationPath(installationId),
    },
  );
}

async function oidcClientCreateRequestFromValue(input: {
  value: unknown;
  installationId: string;
  defaultIssuer: string;
  now: number;
}): Promise<
  { binding: string; client: OidcClientRecord } | undefined | Response
> {
  if (input.value === undefined) return undefined;
  const value = Array.isArray(input.value)
    ? input.value.length === 1
      ? input.value[0]
      : undefined
    : input.value;
  if (!isRecord(value)) {
    return errorJson(
      "invalid_oidc_clients",
      "oidcClients must contain exactly one client object",
      400,
    );
  }
  const redirectUris = oidcRedirectUrisValue(value.redirectUris);
  const authMethod =
    oidcClientAuthMethodValue(
      value.tokenEndpointAuthMethod ?? value.token_endpoint_auth_method,
    ) ?? "none";
  if (authMethod !== "none") {
    return errorJson(
      "invalid_oidc_clients",
      "installation OIDC clients are public PKCE clients; tokenEndpointAuthMethod must be none",
      400,
    );
  }
  if (hasRemovedOidcNamespaceAlias(value)) {
    return errorJson(
      "invalid_oidc_clients",
      "oidcClients entries use servicePath; serviceId/service_id are not accepted",
      400,
    );
  }
  // Accept namespacePath aliases for existing API callers; new requests use servicePath.
  const namespacePathInput =
    value.servicePath ??
    value.service_path ??
    value.namespacePath ??
    value.namespace_path;
  const namespacePathValue = namespacePathInput;
  const issuerUrlInput = value.issuerUrl ?? value.issuer_url;
  const allowedScopesInput = value.allowedScopes ?? value.allowed_scopes;
  const subjectMode = value.subjectMode ?? value.subject_mode ?? "pairwise";
  const binding = stringValue(value.serviceBinding) ?? "auth";
  const namespacePath =
    oidcNamespacePathValue(namespacePathValue) ?? "takosumi.identity.oidc";
  const issuerUrl = oidcIssuerUrlValue(issuerUrlInput) ?? input.defaultIssuer;
  const allowedScopes = oidcAllowedScopesValue(allowedScopesInput) ?? [
    "openid",
  ];
  if (
    !redirectUris ||
    (namespacePathValue !== undefined &&
      !oidcNamespacePathValue(namespacePathValue)) ||
    (issuerUrlInput !== undefined && !oidcIssuerUrlValue(issuerUrlInput)) ||
    (allowedScopesInput !== undefined &&
      !oidcAllowedScopesValue(allowedScopesInput)) ||
    subjectMode !== "pairwise"
  ) {
    return errorJson(
      "invalid_oidc_clients",
      "oidcClients entries require redirectUris, optional serviceBinding, optional servicePath, optional issuerUrl, allowedScopes containing openid, and subjectMode pairwise",
      400,
    );
  }
  return {
    binding,
    client: {
      clientId: stringValue(value.clientId) ?? `toc_${crypto.randomUUID()}`,
      installationId: input.installationId,
      namespacePath,
      issuerUrl,
      redirectUris,
      allowedScopes,
      subjectMode: "pairwise",
      tokenEndpointAuthMethod: authMethod,
      clientSecretHash: undefined,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

function materializeOidcClientBinding(input: {
  bindings: readonly ServiceBindingMaterialRecord[];
  oidcClient: { binding: string; client: OidcClientRecord } | undefined;
  installationId: string;
  now: number;
}): readonly ServiceBindingMaterialRecord[] | Response {
  if (!input.oidcClient) return input.bindings;
  const index = input.bindings.findIndex(
    (binding) => binding.name === input.oidcClient?.binding,
  );
  if (index < 0 || input.bindings[index].kind !== "identity.oidc") {
    return errorJson(
      "invalid_oidc_clients",
      "oidcClients[].serviceBinding must reference an identity.oidc service binding",
      422,
    );
  }
  const binding = input.bindings[index];
  const materialized: ServiceBindingMaterialRecord = {
    ...binding,
    configRef: oidcBindingConfigRef({
      installationId: input.installationId,
      binding: binding.name,
      clientId: input.oidcClient.client.clientId,
    }),
    secretRefs: [],
    updatedAt: input.now,
  };
  try {
    assertValidServiceBindingMaterialRecord(materialized);
  } catch (error) {
    consoleErrorRedacted("invalid_oidc_binding", error);
    return errorJson("invalid_bindings", "binding record is invalid", 422);
  }
  const bindings = [...input.bindings];
  bindings[index] = materialized;
  return bindings;
}

function bindingRef(
  installationId: string,
  binding: string,
  ...segments: string[]
): string {
  const tail = segments.map((s) => encodeURIComponent(s)).join("/");
  return `takosumi-accounts://installations/${encodeURIComponent(
    installationId,
  )}/service-bindings/${encodeURIComponent(binding)}/${tail}`;
}

function oidcBindingConfigRef(input: {
  installationId: string;
  binding: string;
  clientId: string;
}): string {
  return bindingRef(
    input.installationId,
    input.binding,
    "oidc-client",
    input.clientId,
  );
}

function materializeLaunchTokenBindings(input: {
  bindings: readonly ServiceBindingMaterialRecord[];
  launchTokens: LaunchTokenOptions | undefined;
  installationId: string;
  now: number;
}):
  | {
      bindings: readonly ServiceBindingMaterialRecord[];
      materialized: readonly ServiceBindingMaterialRecord[];
    }
  | Response {
  if (!input.launchTokens) {
    return { bindings: input.bindings, materialized: [] };
  }
  const bindings: ServiceBindingMaterialRecord[] = [];
  const materialized: ServiceBindingMaterialRecord[] = [];
  for (const binding of input.bindings) {
    if (binding.kind !== "auth.bootstrap_token") {
      bindings.push(binding);
      continue;
    }
    const next: ServiceBindingMaterialRecord = {
      ...binding,
      configRef: launchTokenBindingConfigRef({
        installationId: input.installationId,
        binding: binding.name,
      }),
      secretRefs: [],
      updatedAt: input.now,
    };
    try {
      assertValidServiceBindingMaterialRecord(next);
    } catch (error) {
      consoleErrorRedacted("invalid_launch_token_binding", error);
      return errorJson("invalid_bindings", "binding record is invalid", 422);
    }
    if (
      next.configRef !== binding.configRef ||
      next.secretRefs.length !== binding.secretRefs.length
    ) {
      materialized.push(next);
    }
    bindings.push(next);
  }
  return { bindings, materialized };
}

function launchTokenBindingConfigRef(input: {
  installationId: string;
  binding: string;
}): string {
  return bindingRef(input.installationId, input.binding, "launch-token");
}

async function materializeConfiguredServiceBindingMaterials(input: {
  bindings: readonly ServiceBindingMaterialRecord[];
  declarations: ReadonlyMap<string, Record<string, unknown>>;
  materializer?: ServiceBindingMaterializer;
  installation: InstallationRecord;
  issuer: string;
  now: number;
}): Promise<
  | {
      bindings: readonly ServiceBindingMaterialRecord[];
      materialized: readonly ServiceBindingMaterialRecord[];
      env: Record<string, string>;
    }
  | Response
> {
  if (!input.materializer) {
    return { bindings: input.bindings, materialized: [], env: {} };
  }

  const bindings: ServiceBindingMaterialRecord[] = [];
  const materialized: ServiceBindingMaterialRecord[] = [];
  const env: Record<string, string> = {};
  for (const binding of input.bindings) {
    if (isBuiltinAccountsBinding(binding.kind)) {
      bindings.push(binding);
      continue;
    }
    let result: ServiceBindingMaterializationResult | undefined;
    try {
      result = await input.materializer({
        installation: input.installation,
        binding,
        declaration: input.declarations.get(binding.name),
        issuer: input.issuer,
      });
    } catch (error) {
      consoleErrorRedacted("binding_materialization_failed", error);
      return errorJson(
        "invalid_binding_materialization",
        "binding materialization failed",
        422,
      );
    }
    if (!result) {
      bindings.push(binding);
      continue;
    }
    const next: ServiceBindingMaterialRecord = {
      ...binding,
      configRef: result.configRef,
      secretRefs: result.secretRefs ?? [],
      updatedAt: input.now,
    };
    try {
      assertValidServiceBindingMaterialRecord(next);
    } catch (error) {
      consoleErrorRedacted("invalid_materialized_binding", error);
      return errorJson(
        "invalid_binding_materialization",
        "binding materialization failed",
        422,
      );
    }
    for (const [key, value] of Object.entries(result.env ?? {})) {
      if (typeof value !== "string") {
        return errorJson(
          "invalid_binding_materialization",
          `binding ${binding.name} env ${key} must be a string`,
          422,
        );
      }
      const publicEnvIssue = publicServiceBindingEnvIssue(key, value);
      if (publicEnvIssue) {
        return errorJson(
          "invalid_binding_materialization",
          `binding ${binding.name} env ${key} ${publicEnvIssue}`,
          422,
        );
      }
      const existingKey = Object.keys(env).find(
        (candidate) => candidate.toUpperCase() === key.toUpperCase(),
      );
      if (existingKey && env[existingKey] !== value) {
        return errorJson(
          "invalid_binding_materialization",
          `binding env ${key} is produced by more than one binding`,
          422,
        );
      }
      env[existingKey ?? key] = value;
    }
    if (
      next.configRef !== binding.configRef ||
      next.secretRefs.join("\n") !== binding.secretRefs.join("\n")
    ) {
      materialized.push(next);
    }
    bindings.push(next);
  }
  return { bindings, materialized, env };
}

function publicServiceBindingEnvIssue(
  name: string,
  value: string,
): string | undefined {
  if (!PUBLIC_SERVICE_BINDING_ENV_NAME_PATTERN.test(name)) {
    return "must be an uppercase environment variable name";
  }
  if (isSecretBearingServiceBindingEnvName(name)) {
    return "may carry secret material; use secretRefs";
  }
  if (serviceBindingEnvValueLooksSecret(value)) {
    return "value may carry secret material; use secretRefs";
  }
  return undefined;
}

function isSecretBearingServiceBindingEnvName(name: string): boolean {
  const normalized = name.toUpperCase();
  return (
    SECRET_BEARING_SERVICE_BINDING_ENV_NAME_PATTERN.test(normalized) ||
    SECRET_BEARING_SERVICE_BINDING_ENV_EXACT_NAMES.has(normalized) ||
    SECRET_BEARING_SERVICE_BINDING_ENV_SUFFIXES.some((suffix) =>
      normalized.endsWith(suffix),
    )
  );
}

function serviceBindingEnvValueLooksSecret(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (SECRET_BEARING_SERVICE_BINDING_ENV_VALUE_PATTERN.test(trimmed)) {
    return true;
  }
  try {
    const url = new URL(trimmed);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function isBuiltinAccountsBinding(kind: ServiceBindingMaterialKind): boolean {
  return kind === "identity.oidc" || kind === "auth.bootstrap_token";
}

function serviceBindingMaterialDeclarationsFromValue(
  value: unknown,
): ReadonlyMap<string, Record<string, unknown>> | Response {
  const declarations = new Map<string, Record<string, unknown>>();
  if (value === undefined) return declarations;
  if (!Array.isArray(value))
    return errorJson(
      "invalid_service_bindings",
      "invalid service bindings",
      400,
    );
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry))
      return errorJson(
        "invalid_service_bindings",
        "invalid service bindings",
        400,
      );
    const name = stringValue(entry.name);
    if (!name) continue;
    const declaration = entry.declaration ?? entry.request;
    if (declaration === undefined) continue;
    if (!isRecord(declaration)) {
      return errorJson(
        "invalid_service_bindings",
        `serviceBindings[${index}].declaration must be an object when present`,
        400,
      );
    }
    declarations.set(name, declaration);
  }
  return declarations;
}

async function appInstallationConfirmFromValue(input: {
  value: unknown;
  bindings: readonly ServiceBindingMaterialRecord[];
  grants: readonly ServiceGrantMaterialRecord[];
}): Promise<AppInstallationConfirmRecord | Response | undefined> {
  if (input.value === undefined) return undefined;
  if (!isRecord(input.value)) {
    return errorJson("invalid_confirm", "confirm must be an object", 400);
  }
  const permissionDigest = stringValue(
    input.value.permissionDigest ?? input.value.permission_digest,
  );
  const costAck = input.value.costAck ?? input.value.cost_ack;
  const approvalRequired = booleanValue(
    input.value.approvalRequired ?? input.value.approval_required,
  );
  const expiresAt = stringValue(
    input.value.expiresAt ?? input.value.expires_at,
  );
  if (
    !permissionDigest ||
    !/^sha256:[0-9a-f]{64}$/.test(permissionDigest) ||
    (costAck !== undefined && typeof costAck !== "boolean") ||
    (approvalRequired !== undefined && typeof approvalRequired !== "boolean")
  ) {
    return errorJson(
      "invalid_confirm",
      "confirm requires permissionDigest=sha256:<64-hex> and optional boolean costAck/approvalRequired",
      400,
    );
  }
  const expectedPermissionDigest = await appInstallationPermissionDigest(input);
  if (permissionDigest !== expectedPermissionDigest) {
    return errorJson(
      "approval_digest_mismatch",
      "confirm.permissionDigest does not match requested service bindings and service grants",
      409,
      undefined,
      {},
      { expected_permission_digest: expectedPermissionDigest },
    );
  }
  if (input.bindings.some((binding) => isMeteredBindingKind(binding.kind))) {
    if (costAck !== true) {
      return errorJson(
        "cost_ack_required",
        "confirm.costAck=true is required when requested service bindings include metered provider resources",
        400,
      );
    }
  }
  return {
    permissionDigest,
    costAck: costAck === true,
    ...(approvalRequired !== undefined ? { approvalRequired } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function spaceKindValue(value: unknown): SpaceKind | undefined {
  return value === "personal" || value === "team" || value === "org"
    ? value
    : undefined;
}

async function assertBillingAllowsInstallationCreate(input: {
  store: AccountsStore;
  accountId: string;
  billingAccountId: string | undefined;
  plan: string | undefined;
  mode: string;
}): Promise<Response | undefined> {
  const requestedPlan = input.plan?.toLowerCase();
  const isPaidPlan = installationPlanIsPaid({
    plan: requestedPlan,
    mode: input.mode,
  });
  if (!isPaidPlan) return undefined;

  const billingAccount = await resolveBillingAccountForGuard({
    store: input.store,
    accountId: input.accountId,
    billingAccountId: input.billingAccountId,
  });
  if (!billingAccount) return undefined;

  if (BILLING_BLOCKED_STATUSES_FOR_PAID_PLANS.has(billingAccount.status)) {
    return errorJson(
      "billing_required",
      `billing account is in status \"${billingAccount.status}\"; resolve outstanding billing before installing a paid plan`,
      402,
    );
  }
  return undefined;
}

function installationPlanIsPaid(input: {
  plan: string | undefined;
  mode: string;
}): boolean {
  if (input.plan && FREE_PLAN_CODES.has(input.plan)) return false;
  // Treat shared-cell installs without an explicit paid plan code as the
  // operator-funded shared-cell trial tier and let them through.
  if (!input.plan && input.mode === "shared-cell") return false;
  return Boolean(input.plan);
}

async function resolveBillingAccountForGuard(input: {
  store: AccountsStore;
  accountId: string;
  billingAccountId: string | undefined;
}) {
  if (input.billingAccountId) {
    return await input.store.findBillingAccount(input.billingAccountId);
  }
  const ledger = await input.store.findLedgerAccount(input.accountId);
  if (ledger?.billingAccountId) {
    return await input.store.findBillingAccount(ledger.billingAccountId);
  }
  return undefined;
}

const BILLING_BLOCKED_STATUSES_FOR_PAID_PLANS: ReadonlySet<string> = new Set([
  "canceled",
  "unpaid",
  "past_due",
  "disputed",
]);

const FREE_PLAN_CODES: ReadonlySet<string> = new Set([
  "free",
  "trial",
  "shared-cell",
  "shared_cell",
]);
