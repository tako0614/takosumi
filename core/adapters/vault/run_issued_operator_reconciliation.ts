import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import {
  canonicalRunCredentialSettings,
  isCapsuleRunCredentialIssuance,
  isWorkspaceBindableOperatorConnection,
  type FixedOperatorProviderConnectionDeclaration,
} from "takosumi-contract";
import type { CredentialRecipe } from "takosumi-contract/credential-recipes";
import {
  canonicalProviderSource,
  sameProviderSource,
} from "takosumi-contract/provider-env-rules";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import type { OpenTofuControlStore } from "../../domains/deploy-control/store.ts";
import {
  credentialRecipeDriverKey,
  type CredentialDriverFetch,
  type CredentialRecipeDriverRegistry,
} from "./driver_ports.ts";

/** The only durable operations needed by this fixed-id startup seam. */
export type RunIssuedOperatorConnectionReconcileStore = Pick<
  OpenTofuControlStore,
  "getConnection" | "getSecretBlob" | "createConnectionIfAbsent"
>;

export interface ReconcileRunIssuedOperatorConnectionInput {
  readonly store: RunIssuedOperatorConnectionReconcileStore;
  readonly descriptor: FixedOperatorProviderConnectionDeclaration;
  readonly credentialRecipeResolver: (
    id: string,
  ) => CredentialRecipe | undefined;
  readonly credentialDrivers: CredentialRecipeDriverRegistry;
  readonly fetch?: CredentialDriverFetch;
  readonly now?: () => Date;
}

export type ReconcileRunIssuedOperatorConnectionResult = {
  readonly status: "created" | "unchanged";
  readonly connection: ProviderConnection;
};

export class RunIssuedOperatorConnectionReconcileError extends Error {
  constructor(
    readonly code:
      | "invalid_descriptor"
      | "drift"
      | "stored_material"
      | "verification_failed"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "RunIssuedOperatorConnectionReconcileError";
  }
}

/**
 * Reconcile one host-declared fixed-id operator Connection. Existing rows are
 * immutable: only an exact semantic match is accepted. Missing rows are
 * verified and inserted atomically; a concurrent winner is reread at the same
 * id and accepted only when its shape is exact.
 */
export async function reconcileRunIssuedOperatorConnection(
  input: ReconcileRunIssuedOperatorConnectionInput,
): Promise<ReconcileRunIssuedOperatorConnectionResult> {
  const now = input.now?.() ?? (() => new Date())();
  if (!Number.isFinite(now.getTime())) {
    throw reconcileError("invalid_descriptor", "now must be a valid Date");
  }
  const target = resolveTargetConnection(
    input.descriptor,
    input.credentialRecipeResolver,
    input.credentialDrivers,
    now.toISOString(),
  );
  const existing = await input.store.getConnection(target.id);
  if (existing) {
    return await acceptExisting(input.store, existing, target);
  }

  await assertNoStoredMaterial(input.store, target.id);
  await verifyTargetConnection(input, target);
  if (await input.store.createConnectionIfAbsent(target)) {
    return await acceptPersisted(input.store, target, "created");
  }

  // Another isolate won the fixed-id insert. Only that same row may satisfy
  // this declaration; no list, replacement, migration, or singleton scan is
  // allowed here.
  const winner = await input.store.getConnection(target.id);
  if (!winner) {
    throw reconcileError(
      "conflict",
      `fixed Connection id ${target.id} disappeared during reconciliation`,
    );
  }
  return await acceptExisting(input.store, winner, target);
}

/** Resolve and validate a declaration without reading or writing durable state. */
export function resolveTargetConnection(
  descriptor: FixedOperatorProviderConnectionDeclaration,
  credentialRecipeResolver: (id: string) => CredentialRecipe | undefined,
  credentialDrivers: CredentialRecipeDriverRegistry,
  timestamp: string,
): ProviderConnection {
  validateDescriptor(descriptor);
  const runCredentialSettings = canonicalRunCredentialSettings(
    descriptor.runCredentialSettings,
    "operator Provider Connection declaration runCredentialSettings",
  );
  const recipe = credentialRecipeResolver(descriptor.credentialRecipe.id);
  const mode = recipe?.authModes[descriptor.credentialRecipe.authMode];
  const driver = credentialDrivers[
    credentialRecipeDriverKey(descriptor.credentialRecipe)
  ];
  if (
    !recipe ||
    !mode ||
    !isCapsuleRunCredentialIssuance(mode.runIssuance) ||
    !mode.preRun?.type.trim() ||
    typeof driver?.verify !== "function" ||
    typeof driver.mint !== "function" ||
    !isSafeEvidenceIssuer(driver.evidenceIssuer)
  ) {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection requires one installed run-issued recipe, preRun action, and verifier/driver",
    );
  }
  if (
    recipe.terraformSource !== "*" &&
    !recipe.terraformSource.some((source) =>
      sameProviderSource(source, descriptor.providerSource),
    )
  ) {
    throw reconcileError(
      "invalid_descriptor",
      `installed recipe does not declare provider ${descriptor.providerSource}`,
    );
  }
  const envNames = [
    ...(recipe.envNames ?? Object.keys(mode.env ?? {}).filter((name) => name !== "*")),
  ].sort();
  const fileEnvNames = Object.values(mode.files ?? {})
    .flatMap((file) => (file.envName ? [file.envName] : []))
    .sort();
  if (envNames.length === 0 && fileEnvNames.length === 0) {
    throw reconcileError(
      "invalid_descriptor",
      "installed run-issued recipe must declare its runner env/file names",
    );
  }
  const credentialRecipe = {
    id: descriptor.credentialRecipe.id,
    authMode: descriptor.credentialRecipe.authMode,
    envNames,
    fileEnvNames,
    requiredEnvGroups: (recipe.requiredEnvGroups ?? []).map((group) =>
      [...group].sort(),
    ),
    ...(recipe.declaredEnv === true ? { declaredEnv: true } : {}),
    preRunAction: mode.preRun.type,
    runIssuance: {
      context: "capsule-run.v1" as const,
      operatorConnection: "workspace-bindable" as const,
      storedMaterial: "none" as const,
      audience: mode.runIssuance.audience,
      scopes: [...mode.runIssuance.scopes].sort(),
    },
  };
  return Object.freeze({
    id: descriptor.id,
    provider: descriptor.providerSource,
    providerSource: canonicalProviderSource(descriptor.providerSource),
    credentialRecipe,
    scope: "operator",
    ...(descriptor.displayName !== undefined
      ? { displayName: descriptor.displayName }
      : {}),
    ...(runCredentialSettings ? { runCredentialSettings } : {}),
    status: "verified",
    materialization: "run-issued",
    envNames,
    ...(fileEnvNames.length > 0 ? { fileEnvNames } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    verifiedAt: timestamp,
  });
}

function validateDescriptor(
  descriptor: FixedOperatorProviderConnectionDeclaration,
): void {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor)
  ) {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection declaration must be an object",
    );
  }
  exactKeys(
    descriptor,
    [
      "id",
      "providerSource",
      "displayName",
      "runCredentialSettings",
      "credentialRecipe",
    ],
    "operator Provider Connection declaration",
  );
  try {
    canonicalRunCredentialSettings(
      descriptor.runCredentialSettings,
      "operator Provider Connection declaration runCredentialSettings",
    );
  } catch {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection declaration runCredentialSettings is invalid",
    );
  }
  if (!/^conn_[0-9A-Za-z]{8,64}$/u.test(descriptor.id)) {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection declaration id must be a canonical conn_ id",
    );
  }
  if (
    typeof descriptor.providerSource !== "string" ||
    descriptor.providerSource !== canonicalProviderSource(descriptor.providerSource)
  ) {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection declaration providerSource must be canonical",
    );
  }
  if (
    descriptor.displayName !== undefined &&
    !isBoundedControlFreeText(descriptor.displayName)
  ) {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection declaration displayName is invalid",
    );
  }
  if (
    !descriptor.credentialRecipe ||
    typeof descriptor.credentialRecipe !== "object" ||
    Array.isArray(descriptor.credentialRecipe)
  ) {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection declaration credentialRecipe is invalid",
    );
  }
  exactKeys(
    descriptor.credentialRecipe,
    ["id", "authMode"],
    "operator Provider Connection declaration credentialRecipe",
  );
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(
      descriptor.credentialRecipe.id,
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(
      descriptor.credentialRecipe.authMode,
    )
  ) {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection declaration credentialRecipe values are invalid",
    );
  }
}

async function acceptExisting(
  store: RunIssuedOperatorConnectionReconcileStore,
  existing: ProviderConnection,
  target: ProviderConnection,
): Promise<ReconcileRunIssuedOperatorConnectionResult> {
  if (
    !isWorkspaceBindableOperatorConnection(existing) ||
    !sameConnectionSemantics(existing, target)
  ) {
    throw reconcileError(
      "drift",
      `fixed Connection id ${target.id} does not exactly match the installed operator Provider Connection declaration`,
    );
  }
  await assertNoStoredMaterial(store, target.id);
  const persisted = await store.getConnection(target.id);
  if (
    !persisted ||
    !isWorkspaceBindableOperatorConnection(persisted) ||
    !sameConnectionSemantics(persisted, target)
  ) {
    throw reconcileError(
      "conflict",
      `fixed Connection id ${target.id} changed during reconciliation`,
    );
  }
  await assertNoStoredMaterial(store, target.id);
  return { status: "unchanged", connection: persisted };
}

async function acceptPersisted(
  store: RunIssuedOperatorConnectionReconcileStore,
  target: ProviderConnection,
  status: "created" | "unchanged",
): Promise<ReconcileRunIssuedOperatorConnectionResult> {
  const persisted = await store.getConnection(target.id);
  if (
    !persisted ||
    !isWorkspaceBindableOperatorConnection(persisted) ||
    !sameConnectionSemantics(persisted, target)
  ) {
    throw reconcileError(
      "conflict",
      `fixed Connection id ${target.id} changed during reconciliation`,
    );
  }
  await assertNoStoredMaterial(store, target.id);
  return { status, connection: persisted };
}

async function verifyTargetConnection(
  input: ReconcileRunIssuedOperatorConnectionInput,
  target: ProviderConnection,
): Promise<void> {
  const driver = input.credentialDrivers[
    credentialRecipeDriverKey(target.credentialRecipe!)
  ];
  if (!driver || typeof driver.verify !== "function") {
    throw reconcileError(
      "invalid_descriptor",
      "operator Provider Connection verifier is not installed",
    );
  }
  const staticEvidence = (): ProviderCredentialMintEvidence => ({
    connectionId: target.id,
    provider: target.provider,
    temporary: true,
    ttlEnforced: true,
    issuer: driver.evidenceIssuer,
    secretValueStored: false,
  });
  let result: { readonly ok: boolean };
  try {
    result = await driver.verify({
      connection: target,
      values: {},
      files: [],
      fetch: input.fetch ?? ((request, init) => fetch(request, init)),
      now: input.now ?? (() => new Date()),
      staticEvidence,
    });
  } catch {
    throw reconcileError(
      "verification_failed",
      "operator Provider Connection verification failed",
    );
  }
  if (!result || result.ok !== true) {
    throw reconcileError(
      "verification_failed",
      "operator Provider Connection verification failed",
    );
  }
}

async function assertNoStoredMaterial(
  store: Pick<RunIssuedOperatorConnectionReconcileStore, "getSecretBlob">,
  id: string,
): Promise<void> {
  if (await store.getSecretBlob(id)) {
    throw reconcileError(
      "stored_material",
      `fixed Connection id ${id} unexpectedly has stored credential material`,
    );
  }
}

function sameConnectionSemantics(
  left: ProviderConnection,
  right: ProviderConnection,
): boolean {
  const stripLifecycle = (connection: ProviderConnection) => {
    const {
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      verifiedAt: _verifiedAt,
      ...semantic
    } = connection;
    return semantic;
  };
  return sameExactValue(stripLifecycle(left), stripLifecycle(right));
}

function sameExactValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameExactValue(value, right[index]))
    );
  }
  if (
    !left ||
    typeof left !== "object" ||
    !right ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameExactValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw reconcileError(
      "invalid_descriptor",
      `${label} contains unknown fields: ${unknown.join(", ")}`,
    );
  }
}

function isBoundedControlFreeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isSafeEvidenceIssuer(value: unknown): value is string {
  return isBoundedControlFreeText(value);
}

function reconcileError(
  code: RunIssuedOperatorConnectionReconcileError["code"],
  message: string,
): RunIssuedOperatorConnectionReconcileError {
  return new RunIssuedOperatorConnectionReconcileError(code, message);
}
