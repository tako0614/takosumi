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
  type AccountsInstallationExportBundle,
  parseAccountsInstallationExportBundle,
  planInstallationImport,
} from "./export-bundle.ts";
import {
  type AppBindingKind,
  type AppBindingRecord,
  type AppGrantRecord,
  type InstallationRecord,
  type SpaceKind,
  assertValidAppBindingRecord,
} from "./ledger.ts";
import type {
  AccountsStore,
  OidcClientRecord,
} from "./store.ts";
import type {
  SharedCellRuntimeAllocator,
} from "./runtime.ts";
import {
  sha256Text,
} from "./encoding.ts";
import {
  appInstallationPermissionDigest,
  appendImportDataRestoreFailure,
  installationActivatedHttpDomainEvent,
  installationEnvelope,
  isMeteredBindingKind,
  isSha256DigestRef,
  parseAppInstallationImportData,
  serializeAppInstallation,
  serializeInstallationEvent,
} from "./installation-helpers.ts";
import {
  runtimeBindingFromValue,
} from "./installation-materialize-helpers.ts";
import {
  hasRemovedOidcNamespaceAlias,
  oidcAllowedScopesValue,
  oidcClientAuthMethodValue,
  oidcIssuerUrlValue,
  oidcNamespacePathValue,
  oidcRedirectUrisValue,
} from "./installation-routes-internal.ts";
import {
  appInstallationStatusValue,
  booleanValue,
  isRecord,
  json,
  readJsonObject,
  stringValue,
  takosumiSubjectValue,
} from "./http-helpers.ts";
import type {
  AppBindingMaterializationResult,
  AppBindingMaterializer,
  AppInstallationImportDataRestorer,
  LaunchTokenOptions,
} from "./mod.ts";
import type {
  DeployControlProxyOptions,
} from "./deploy-control-proxy.ts";
import {
  appendLedgerEvent,
} from "./installation-ledger-events.ts";
import {
  type AppInstallationConfirmRecord,
  activatedHttpDomainEventPayload,
  appBindingRecordsFromValue,
  appGrantRecordsFromValue,
  appInstallationModeValue,
  applyCoreInstallationForCloudProjection,
} from "./installation-lifecycle-shared.ts";

export async function handleCreateAppInstallation(input: {
  request: Request;
  store: AccountsStore;
  issuer: string;
  deployControl?: DeployControlProxyOptions;
  launchTokens?: LaunchTokenOptions;
  bindingMaterializer?: AppBindingMaterializer;
  sharedCellRuntime?: SharedCellRuntimeAllocator;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);

  const source = isRecord(body.source) ? body.source : {};
  const expected = isRecord(body.expected) ? body.expected : undefined;
  const now = Date.now();
  const requestedInstallationId = stringValue(body.installationId);
  const accountId = stringValue(body.accountId);
  const spaceId = stringValue(body.spaceId);
  let appId = stringValue(body.appId);
  let sourceGitUrl = stringValue(source.gitUrl) ?? stringValue(source.url);
  let sourceRef = stringValue(source.ref);
  let sourceCommit = stringValue(expected?.sourceCommit) ??
    stringValue(source.commit);
  let planDigest = stringValue(expected?.planDigest) ??
    stringValue(source.planDigest) ??
    stringValue(body.planDigest);
  let artifactDigest = stringValue(expected?.planArtifactDigest) ??
    stringValue(source.artifactDigest) ??
    stringValue(body.artifactDigest);
  const planRunId = stringValue(source.planRunId) ??
    stringValue(body.planRunId) ??
    stringValue(body.plan_run_id) ??
    stringValue(expected?.planRunId);
  const mode = appInstallationModeValue(body.mode);
  const billingAccountId = stringValue(
    body.billingAccountId ?? body.billing_account_id,
  );
  const createdBySubject = takosumiSubjectValue(body.createdBySubject);
  if (!accountId || !spaceId || !mode || !createdBySubject) {
    return json({
      error: "invalid_request",
      error_description:
        "accountId, spaceId, mode, and createdBySubject are required",
    }, 400);
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
    return json({ error: "space_account_mismatch" }, 409);
  }
  if (input.deployControl && requestedInstallationId) {
    return json({
      error: "invalid_request",
      error_description:
        "installationId is assigned by Takosumi deploy control for this Accounts facade",
    }, 400);
  }
  if (input.deployControl && !expected) {
    return json({
      error: "invalid_request",
      error_description:
        "installation apply through Takosumi deploy control requires expected review guards",
    }, 400);
  }
  if (
    (planDigest !== undefined &&
      !isSha256DigestRef(planDigest)) ||
    (artifactDigest !== undefined &&
      !isSha256DigestRef(artifactDigest))
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "source.planDigest and source.artifactDigest must be sha256: digest references",
    }, 400);
  }
  if (input.deployControl) {
    const preflightBindings = appBindingRecordsFromValue({
      value: body.useEdges,
      installationId: "inst_core_apply_preflight",
      now,
    });
    if (preflightBindings instanceof Response) return preflightBindings;
    const preflightGrants = appGrantRecordsFromValue({
      value: body.permissionScopes,
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
  }
  const coreApply = input.deployControl
    ? await applyCoreInstallationForCloudProjection({
      deployControl: input.deployControl,
      spaceId,
      source,
      expected,
      planRunId,
    })
    : undefined;
  if (coreApply instanceof Response) return coreApply;
  if (coreApply) {
    appId = coreApply.appId;
    sourceGitUrl = coreApply.sourceUrl;
    sourceRef = coreApply.sourceRef;
    sourceCommit = coreApply.sourceCommit ?? coreApply.sourceDigest;
    planDigest = coreApply.planDigest;
    artifactDigest = coreApply.artifactDigest;
  }
  const installationId = requestedInstallationId ??
    coreApply?.installationId ??
    `inst_${crypto.randomUUID()}`;
  // Duplicate guard. NOTE: this is a check-then-act, not an atomic
  // conditional insert. `saveAppInstallation` later overwrites on conflict
  // (D1 `INSERT OR REPLACE`; Postgres `ON CONFLICT DO UPDATE`), so two
  // concurrent creates with the same caller-influenced installationId can
  // both pass this check and the second silently overwrites the first. The
  // common path is safe: when `input.deployControl` is wired the space deployControl
  // assigns the id (a caller-supplied requestedInstallationId is rejected
  // above), and space-assigned/random ids do not collide. Fully closing the
  // no-deployControl + caller-supplied-id race requires an atomic putIfAbsent
  // on `saveAppInstallation` in the store implementations.
  if (await input.store.findAppInstallation(installationId)) {
    return json({ error: "installation_already_exists" }, 409);
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
    return json({
      error: "invalid_request",
      error_description:
        "accountId, spaceId, appId, source.gitUrl/url, source.ref, source.commit, source.planDigest, mode, and createdBySubject are required",
    }, 400);
  }
  // These fields are digest-typed integrity attestations recorded in the
  // ledger (surfaced as plan_digest); reject values that are not a
  // `sha256:`-prefixed digest reference so the provenance the ledger claims is
  // not weakened by arbitrary junk strings.
  if (
    !isSha256DigestRef(planDigest) ||
    (artifactDigest !== undefined &&
      !isSha256DigestRef(artifactDigest))
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "source.planDigest and source.artifactDigest must be sha256: digest references",
    }, 400);
  }

  const status = appInstallationStatusValue(body.status) ??
    (coreApply ? "ready" : "installing");
  let runtimeBinding = runtimeBindingFromValue({
    value: body.runtimeTarget,
    installationId,
    mode,
    now,
  });
  let runtimeBindingAutoAssigned = false;
  if (
    !runtimeBinding &&
    mode === "shared-cell" &&
    input.sharedCellRuntime
  ) {
    runtimeBinding = await input.sharedCellRuntime({
      installationId,
      accountId,
      spaceId,
      appId,
      createdBySubject,
      now,
    });
    if (!runtimeBinding) {
      return json({
        error: "shared_cell_capacity_unavailable",
        error_description:
          "shared-cell install requires an available warm runtime slot",
      }, 503);
    }
    if (
      runtimeBinding.installationId !== installationId ||
      runtimeBinding.mode !== "shared-cell" ||
      runtimeBinding.targetType !== "shared-cell"
    ) {
      return json({
        error: "invalid_shared_cell_runtime_target",
        error_description:
          "shared-cell runtime allocator must return a shared-cell runtime target for the requested installation",
      }, 500);
    }
    runtimeBindingAutoAssigned = true;
  }
  const runtimeBindingId = runtimeBinding?.runtimeBindingId ??
    stringValue(body.runtimeTargetId);
  const bindingsResult = appBindingRecordsFromValue({
    value: body.useEdges,
    installationId,
    now,
  });
  if (bindingsResult instanceof Response) return bindingsResult;
  const bindingDeclarations = appBindingDeclarationsFromValue(body.useEdges);
  if (bindingDeclarations instanceof Response) return bindingDeclarations;
  const grantsResult = appGrantRecordsFromValue({
    value: body.permissionScopes,
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
      return json({
        error: "account_claim_conflict",
        error_description:
          "accountId is already owned by a different Takosumi subject",
      }, 409);
    }
  } else {
    await input.store.saveLedgerAccount({
      accountId,
      legalOwnerSubject: createdBySubject,
      billingAccountId,
      createdAt: now,
      updatedAt: now,
    });
    const confirmedLedgerAccount = await input.store.findLedgerAccount(
      accountId,
    );
    if (
      !confirmedLedgerAccount ||
      confirmedLedgerAccount.legalOwnerSubject !== createdBySubject
    ) {
      return json({
        error: "account_claim_conflict",
        error_description:
          "accountId was claimed by another install while creating this one",
      }, 409);
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
      return json({
        error: "space_claim_conflict",
        error_description:
          "spaceId was claimed by another account while creating this one",
      }, 409);
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
  const bindingMaterialization = await materializeConfiguredAppBindings({
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
    await input.store.saveAppBinding(binding);
  }
  for (const grant of grantsResult) {
    await input.store.saveAppGrant(grant);
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
      eventType: "use_edge.materialized",
      payload: {
        useEdge: oidcClientResult.binding,
        kind: "identity.oidc@v1",
        configRef: oidcBindingConfigRef({
          installationId,
          binding: oidcClientResult.binding,
          clientId: oidcClientResult.client.clientId,
        }),
        secretRefs: oidcClientResult.clientSecret
          ? [
            oidcBindingClientSecretRef({
              installationId,
              binding: oidcClientResult.binding,
            }),
          ]
          : [],
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
      eventType: "use_edge.materialized",
      payload: {
        useEdge: binding.name,
        kind: "install-launch-token@v1",
        configRef: binding.configRef,
        secretRefs: [],
      },
      now,
    });
  }
  for (const binding of bindingMaterialization.materialized) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "use_edge.materialized",
      payload: {
        useEdge: binding.name,
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
      ...(oidcClientResult?.clientSecret
        ? { oidc_client_secret: oidcClientResult.clientSecret }
        : {}),
      ...(Object.keys(bindingMaterialization.env).length > 0
        ? { use_edge_env: bindingMaterialization.env }
        : {}),
    },
    202,
    {
      location: takosumiAccountsInstallationPath(installationId),
    },
  );
}

export async function handleImportAppInstallation(input: {
  request: Request;
  store: AccountsStore;
  issuer: string;
  launchTokens?: LaunchTokenOptions;
  bindingMaterializer?: AppBindingMaterializer;
  sharedCellRuntime?: SharedCellRuntimeAllocator;
  importDataRestorer?: AppInstallationImportDataRestorer;
}): Promise<Response> {
  const body = await readJsonObject(input.request);
  if (!body) return json({ error: "invalid_request" }, 400);
  let bundle: AccountsInstallationExportBundle;
  try {
    bundle = parseAccountsInstallationExportBundle(body.bundle);
  } catch (error) {
    console.error(
      "import_bundle_parse_failed",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "invalid_request",
      error_description: "installation export bundle is invalid",
    }, 400);
  }
  const accountId = stringValue(body.targetAccountId) ??
    stringValue(body.accountId);
  const spaceId = stringValue(body.targetSpaceId) ?? stringValue(body.spaceId);
  const createdBySubject = takosumiSubjectValue(
    body.createdBySubject ?? body.subject,
  );
  const mode = body.mode === undefined
    ? undefined
    : body.mode === "dedicated" || body.mode === "self-hosted"
    ? body.mode
    : undefined;
  if (
    !accountId ||
    !spaceId ||
    !createdBySubject ||
    (body.mode !== undefined && !mode)
  ) {
    return json({
      error: "invalid_request",
      error_description:
        "accountId/targetAccountId, spaceId/targetSpaceId, createdBySubject/subject, and optional mode=dedicated|self-hosted are required",
    }, 400);
  }
  let importData;
  try {
    importData = await parseAppInstallationImportData(body.data);
  } catch (error) {
    console.error(
      "import_data_parse_failed",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "invalid_import_data",
      error_description: "import data is invalid",
    }, 400);
  }
  if (importData && !input.importDataRestorer) {
    return json({
      error: "feature_unavailable",
      error_description:
        "Import with provider data is temporarily unavailable.",
    }, 503);
  }

  let plan;
  try {
    plan = planInstallationImport({
      bundle,
      targetIssuer: stringValue(body.targetIssuer) ??
        stringValue(body.authIssuer) ?? input.issuer,
      targetAccountId: accountId,
      targetSpaceId: spaceId,
      targetInstallationId: stringValue(body.targetInstallationId) ??
        stringValue(body.installationId),
      createdBySubject,
      ...(mode ? { mode } : {}),
    });
  } catch (error) {
    console.error(
      "import_bundle_plan_failed",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "invalid_import_bundle",
      error_description: "installation export bundle could not be planned",
    }, 400);
  }

  const createResponse = await handleCreateAppInstallation({
    request: new Request(input.request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan.request),
    }),
    store: input.store,
    issuer: input.issuer,
    launchTokens: input.launchTokens,
    bindingMaterializer: input.bindingMaterializer,
    sharedCellRuntime: input.sharedCellRuntime,
  });
  if (createResponse.status >= 400) return createResponse;

  const created = await createResponse.json();
  const installationId = stringValue(plan.request.installationId);
  let dataRestore;
  let dataRestoreEvent;
  let dataRestoreInstallation;
  if (installationId) {
    await appendLedgerEvent(input.store, {
      installationId,
      eventType: "installation.import-planned",
      payload: {
        bundleKind: plan.bundleKind,
        sourceIssuer: plan.sourceIssuer,
        targetIssuer: plan.targetIssuer,
      },
      now: Date.now(),
    });
    if (importData && input.importDataRestorer) {
      const installation = await input.store.findAppInstallation(
        installationId,
      );
      if (!installation) {
        return json({
          error: "installation_not_found",
          error_description:
            "imported installation disappeared before data restore",
        }, 404);
      }
      try {
        const result = await input.importDataRestorer({
          installation,
          bundle,
          importPlan: plan,
          dataManifest: importData.manifest,
          entries: importData.entries,
        });
        const restoredEntries = result.restoredEntries ??
          importData.entries.map((entry) => entry.path);
        dataRestoreEvent = await appendLedgerEvent(input.store, {
          installationId,
          eventType: "installation.import-data-restored",
          payload: {
            entries: restoredEntries,
            manifestKind: importData.manifest?.kind ?? null,
            evidence: result.evidence ?? {},
          },
          now: Date.now(),
        });
        dataRestore = {
          status: "restored",
          entries: restoredEntries,
          ...(result.evidence ? { evidence: result.evidence } : {}),
        };
      } catch (error) {
        // The full error is recorded server-side (ledger) for operators, but
        // the client-facing response only carries a fixed safe message so we
        // never echo restorer/driver internals back to callers.
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        console.error(
          "import_data_restore_failed",
          error instanceof Error ? error.stack ?? error.message : String(error),
        );
        await appendImportDataRestoreFailure({
          store: input.store,
          installation,
          error: errorMessage,
        });
        dataRestoreInstallation = await input.store.findAppInstallation(
          installationId,
        );
        dataRestore = {
          status: "failed",
          error: "import data restore failed",
        };
      }
    }
  }

  return json(
    {
      ...created,
      ...(dataRestoreInstallation
        ? { installation: serializeAppInstallation(dataRestoreInstallation) }
        : {}),
      import_plan: {
        bundle_kind: plan.bundleKind,
        source_issuer: plan.sourceIssuer,
        target_issuer: plan.targetIssuer,
      },
      ...(dataRestore ? { data_restore: dataRestore } : {}),
      ...(dataRestoreEvent
        ? { data_restore_event: serializeInstallationEvent(dataRestoreEvent) }
        : {}),
    },
    createResponse.status,
    {
      ...(createResponse.headers.get("location")
        ? { location: createResponse.headers.get("location") ?? "" }
        : {}),
    },
  );
}

async function oidcClientCreateRequestFromValue(input: {
  value: unknown;
  installationId: string;
  defaultIssuer: string;
  now: number;
}): Promise<
  | { binding: string; client: OidcClientRecord; clientSecret?: string }
  | undefined
  | Response
> {
  if (input.value === undefined) return undefined;
  const value = Array.isArray(input.value)
    ? input.value.length === 1 ? input.value[0] : undefined
    : input.value;
  if (!isRecord(value)) {
    return json({
      error: "invalid_oidc_clients",
      error_description: "oidcClients must contain exactly one client object",
    }, 400);
  }
  const redirectUris = oidcRedirectUrisValue(value.redirectUris);
  const authMethod = oidcClientAuthMethodValue(
    value.tokenEndpointAuthMethod ?? value.token_endpoint_auth_method,
  ) ?? "client_secret_post";
  if (hasRemovedOidcNamespaceAlias(value)) {
    return json({
      error: "invalid_oidc_clients",
      error_description:
        "oidcClients entries use servicePath; serviceId/service_id are not accepted",
    }, 400);
  }
  // Accept namespacePath aliases for existing API callers; new requests use servicePath.
  const namespacePathInput = value.servicePath ?? value.service_path ??
    value.namespacePath ?? value.namespace_path;
  const namespacePathValue = namespacePathInput;
  const issuerUrlInput = value.issuerUrl ?? value.issuer_url;
  const allowedScopesInput = value.allowedScopes ?? value.allowed_scopes;
  const subjectMode = value.subjectMode ?? value.subject_mode ?? "pairwise";
  const binding = stringValue(value.useEdge) ?? "auth";
  const namespacePath = oidcNamespacePathValue(namespacePathValue) ??
    "identity.primary.oidc";
  const issuerUrl = oidcIssuerUrlValue(issuerUrlInput) ?? input.defaultIssuer;
  const allowedScopes = oidcAllowedScopesValue(allowedScopesInput) ??
    ["openid"];
  if (
    !redirectUris ||
    (namespacePathValue !== undefined &&
      !oidcNamespacePathValue(namespacePathValue)) ||
    (issuerUrlInput !== undefined && !oidcIssuerUrlValue(issuerUrlInput)) ||
    (allowedScopesInput !== undefined &&
      !oidcAllowedScopesValue(allowedScopesInput)) ||
    subjectMode !== "pairwise"
  ) {
    return json({
      error: "invalid_oidc_clients",
      error_description:
        "oidcClients entries require redirectUris, optional useEdge, optional servicePath, optional issuerUrl, allowedScopes containing openid, and subjectMode pairwise",
    }, 400);
  }
  const clientSecret = authMethod === "none"
    ? undefined
    : `toc_${crypto.randomUUID().replaceAll("-", "")}`;
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
      clientSecretHash: clientSecret
        ? await sha256Text(`takosumi-oidc-client:${clientSecret}`)
        : undefined,
      createdAt: input.now,
      updatedAt: input.now,
    },
    clientSecret,
  };
}

function materializeOidcClientBinding(input: {
  bindings: readonly AppBindingRecord[];
  oidcClient:
    | { binding: string; client: OidcClientRecord; clientSecret?: string }
    | undefined;
  installationId: string;
  now: number;
}): readonly AppBindingRecord[] | Response {
  if (!input.oidcClient) return input.bindings;
  const index = input.bindings.findIndex((binding) =>
    binding.name === input.oidcClient?.binding
  );
  if (index < 0 || input.bindings[index].kind !== "identity.oidc@v1") {
    return json({
      error: "invalid_oidc_clients",
      error_description:
        "oidcClients[].useEdge must reference an identity.oidc@v1 use edge",
    }, 422);
  }
  const binding = input.bindings[index];
  const materialized: AppBindingRecord = {
    ...binding,
    configRef: oidcBindingConfigRef({
      installationId: input.installationId,
      binding: binding.name,
      clientId: input.oidcClient.client.clientId,
    }),
    secretRefs: input.oidcClient.clientSecret
      ? [oidcBindingClientSecretRef({
        installationId: input.installationId,
        binding: binding.name,
      })]
      : [],
    updatedAt: input.now,
  };
  try {
    assertValidAppBindingRecord(materialized);
  } catch (error) {
    console.error(
      "invalid_oidc_binding",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return json({
      error: "invalid_bindings",
      error_description: "binding record is invalid",
    }, 422);
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
  return `takosumi-accounts://installations/${
    encodeURIComponent(installationId)
  }/use-edges/${encodeURIComponent(binding)}/${tail}`;
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

function oidcBindingClientSecretRef(input: {
  installationId: string;
  binding: string;
}): string {
  return bindingRef(
    input.installationId,
    input.binding,
    "secrets",
    "client-secret",
  );
}

function materializeLaunchTokenBindings(input: {
  bindings: readonly AppBindingRecord[];
  launchTokens: LaunchTokenOptions | undefined;
  installationId: string;
  now: number;
}): {
  bindings: readonly AppBindingRecord[];
  materialized: readonly AppBindingRecord[];
} | Response {
  if (!input.launchTokens) {
    return { bindings: input.bindings, materialized: [] };
  }
  const bindings: AppBindingRecord[] = [];
  const materialized: AppBindingRecord[] = [];
  for (const binding of input.bindings) {
    if (binding.kind !== "install-launch-token@v1") {
      bindings.push(binding);
      continue;
    }
    const next: AppBindingRecord = {
      ...binding,
      configRef: launchTokenBindingConfigRef({
        installationId: input.installationId,
        binding: binding.name,
      }),
      secretRefs: [],
      updatedAt: input.now,
    };
    try {
      assertValidAppBindingRecord(next);
    } catch (error) {
      console.error(
        "invalid_launch_token_binding",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return json({
        error: "invalid_bindings",
        error_description: "binding record is invalid",
      }, 422);
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

async function materializeConfiguredAppBindings(input: {
  bindings: readonly AppBindingRecord[];
  declarations: ReadonlyMap<string, Record<string, unknown>>;
  materializer?: AppBindingMaterializer;
  installation: InstallationRecord;
  issuer: string;
  now: number;
}): Promise<
  | {
    bindings: readonly AppBindingRecord[];
    materialized: readonly AppBindingRecord[];
    env: Record<string, string>;
  }
  | Response
> {
  if (!input.materializer) {
    return { bindings: input.bindings, materialized: [], env: {} };
  }

  const bindings: AppBindingRecord[] = [];
  const materialized: AppBindingRecord[] = [];
  const env: Record<string, string> = {};
  for (const binding of input.bindings) {
    if (isBuiltinAccountsBinding(binding.kind)) {
      bindings.push(binding);
      continue;
    }
    let result: AppBindingMaterializationResult | undefined;
    try {
      result = await input.materializer({
        installation: input.installation,
        binding,
        declaration: input.declarations.get(binding.name),
        issuer: input.issuer,
      });
    } catch (error) {
      console.error(
        "binding_materialization_failed",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return json({
        error: "invalid_binding_materialization",
        error_description: "binding materialization failed",
      }, 422);
    }
    if (!result) {
      bindings.push(binding);
      continue;
    }
    const next: AppBindingRecord = {
      ...binding,
      configRef: result.configRef,
      secretRefs: result.secretRefs ?? [],
      updatedAt: input.now,
    };
    try {
      assertValidAppBindingRecord(next);
    } catch (error) {
      console.error(
        "invalid_materialized_binding",
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
      return json({
        error: "invalid_binding_materialization",
        error_description: "binding materialization failed",
      }, 422);
    }
    for (const [key, value] of Object.entries(result.env ?? {})) {
      if (typeof value !== "string") {
        return json({
          error: "invalid_binding_materialization",
          error_description:
            `binding ${binding.name} env ${key} must be a string`,
        }, 422);
      }
      const existingKey = Object.keys(env).find((candidate) =>
        candidate.toUpperCase() === key.toUpperCase()
      );
      if (existingKey && env[existingKey] !== value) {
        return json({
          error: "invalid_binding_materialization",
          error_description:
            `binding env ${key} is produced by more than one binding`,
        }, 422);
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

function isBuiltinAccountsBinding(kind: AppBindingKind): boolean {
  return kind === "identity.oidc@v1" || kind === "install-launch-token@v1";
}

function appBindingDeclarationsFromValue(
  value: unknown,
): ReadonlyMap<string, Record<string, unknown>> | Response {
  const declarations = new Map<string, Record<string, unknown>>();
  if (value === undefined) return declarations;
  if (!Array.isArray(value)) return json({ error: "invalid_use_edges" }, 400);
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return json({ error: "invalid_use_edges" }, 400);
    const name = stringValue(entry.name);
    if (!name) continue;
    const declaration = entry.declaration ?? entry.request;
    if (declaration === undefined) continue;
    if (!isRecord(declaration)) {
      return json({
        error: "invalid_use_edges",
        error_description:
          `useEdges[${index}].declaration must be an object when present`,
      }, 400);
    }
    declarations.set(name, declaration);
  }
  return declarations;
}

async function appInstallationConfirmFromValue(input: {
  value: unknown;
  bindings: readonly AppBindingRecord[];
  grants: readonly AppGrantRecord[];
}): Promise<AppInstallationConfirmRecord | Response | undefined> {
  if (input.value === undefined) return undefined;
  if (!isRecord(input.value)) {
    return json({
      error: "invalid_confirm",
      error_description: "confirm must be an object",
    }, 400);
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
    (approvalRequired !== undefined &&
      typeof approvalRequired !== "boolean")
  ) {
    return json({
      error: "invalid_confirm",
      error_description:
        "confirm requires permissionDigest=sha256:<64-hex> and optional boolean costAck/approvalRequired",
    }, 400);
  }
  const expectedPermissionDigest = await appInstallationPermissionDigest(input);
  if (permissionDigest !== expectedPermissionDigest) {
    return json({
      error: "approval_digest_mismatch",
      error_description:
        "confirm.permissionDigest does not match requested use edges and permission scopes",
      expected_permission_digest: expectedPermissionDigest,
    }, 409);
  }
  if (input.bindings.some((binding) => isMeteredBindingKind(binding.kind))) {
    if (costAck !== true) {
      return json({
        error: "cost_ack_required",
        error_description:
          "confirm.costAck=true is required when requested use edges include metered provider resources",
      }, 400);
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
    return json({
      error: "billing_required",
      error_description:
        `billing account is in status \"${billingAccount.status}\"; resolve outstanding billing before installing a paid plan`,
    }, 402);
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
