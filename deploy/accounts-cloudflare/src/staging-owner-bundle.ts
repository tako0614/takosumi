import type { CloudflareWorkerEnv as AccountsEnv } from "./handler.ts";
import type { CloudflareWorkerEnv as ControlEnv } from "../../../worker/src/bindings.ts";
import { createInProcessDeployControlSeam } from "../../../worker/src/deploy_control_seam.ts";
import { D1AccountsStore } from "../../../accounts/service/src/d1-store.ts";
import {
  createAccountsIdentityReconciliationAuthority,
  createControlIdentityReconciler,
  type IdentityExternalOwnerPorts,
  type IdentityRecoveryApprovalAuthority,
} from "../../../accounts/service/src/control-identity-reconciler.ts";
import { createAccountsOwnerOperationReader } from "../../../accounts/service/src/owner-operation-admission.ts";
import type { AccountsStore } from "../../../accounts/service/src/store.ts";
import type { ControlIdentityAuthorityReader, ControlIdentityReconciliationPort } from "../../../contract/identity-reconciliation.ts";
import type { OwnerOperationReader, OwnerOperationRecoveryEvidenceReader, OwnerOperationTarget } from "../../../accounts/service/src/owner-operation-contract.ts";
import type { IdentityMergeReconciler } from "../../../accounts/service/src/identity-merge.ts";
import type { IdentityMergeOperation } from "../../../accounts/service/src/identity-state.ts";
import type { CredentialUnlinkReconciler } from "../../../accounts/service/src/identity-unlink-state.ts";
import type { WorkspaceBillingEnrollmentPort } from "../../../accounts/service/src/workspace-billing-bootstrap.ts";
import { AUTH_STAGING_CLIENTS } from "./staging-target.ts";
import { createReviewedRecoveryApprovalAuthority } from "../../../accounts/service/src/reviewed-recovery-approvals.ts";
import { ensureAccountsD1WorkerSchema } from "./d1-schema-gate.ts";
import { verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../worker/src/d1_opentofu_store.ts";
import { assertControlD1MaintenanceInactive } from "../../../worker/src/d1_schema_maintenance.ts";
import { digest as ownerDigest } from "../../../accounts/service/src/owner-operation-evidence.ts";
import { isReviewedRecoveryIssuerAvailabilityReader, type ReviewedRecoveryIssuerAvailabilityReader } from "../../../accounts/service/src/reviewed-recovery-issuer-availability.ts";

/** Same read-only schema and maintenance closure for HTTP and private RPC. */
export async function verifyAuthStagingOwnerSchema(env: AuthStagingEnv): Promise<void> {
  const evidence = await ensureAccountsD1WorkerSchema(env.TAKOSUMI_ACCOUNTS_DB);
  if (Number(evidence.headVersion) !== 5) throw new Error("auth_staging_schema_invalid");
  await verifyD1OpenTofuLedgerSchemaPredeployed(env.TAKOSUMI_CONTROL_DB);
  await assertControlD1MaintenanceInactive(env.TAKOSUMI_CONTROL_DB);
}

export type AuthStagingEnv = AccountsEnv & ControlEnv;

/** Trusted source composition only. No HTTP body, binding props or descriptor
 * can supply these readers or establish that their deployments are qualified. */
export interface AuthStagingOwnerPorts {
  readonly ownerOperationTarget?: OwnerOperationTarget;
  readonly recoveryApprovals?: IdentityRecoveryApprovalAuthority;
  readonly recoveryEvidence?: OwnerOperationRecoveryEvidenceReader;
  readonly reviewIssuerAvailability?: ReviewedRecoveryIssuerAvailabilityReader;
  readonly externalOwners?: IdentityExternalOwnerPorts;
  readonly workspaceBillingEnrollment?: WorkspaceBillingEnrollmentPort;
  readonly retryAuthorityContextDigest?: string;
}

export interface AuthStagingOwnerBundle {
  readonly store: AccountsStore;
  readonly authority: ControlIdentityAuthorityReader;
  readonly ownerOperationReader: OwnerOperationReader;
  readonly recoveryApprovals?: IdentityRecoveryApprovalAuthority;
  readonly recoveryEvidence?: OwnerOperationRecoveryEvidenceReader;
  readonly reviewIssuerAvailability?: ReviewedRecoveryIssuerAvailabilityReader;
  readonly ports: AuthStagingOwnerPorts & {
    readonly identityMergeReconciler: IdentityMergeReconciler;
    readonly credentialUnlinkReconciler: CredentialUnlinkReconciler;
    readonly assertOwnerReadiness: (operation?: IdentityMergeOperation) => Promise<boolean>;
  };
}

const ownerKinds = ["financial", "hosted-intents", "rp-sessions", "resource-bindings"] as const;

function captureReaders(source: AuthStagingOwnerPorts) {
  const approvals = source.recoveryApprovals;
  const evidence = source.recoveryEvidence;
  const approvalMethods = approvals && {
    findForOperation: approvals.findForOperation.bind(approvals), read: approvals.read.bind(approvals),
  };
  const evidenceMethods = evidence && {
    readRecoveryEvidence: evidence.readRecoveryEvidence.bind(evidence),
    readHistoricalRecoveryEvidence: evidence.readHistoricalRecoveryEvidence.bind(evidence),
    readHistoricalRecoveryEvidenceByReviewRef: evidence.readHistoricalRecoveryEvidenceByReviewRef.bind(evidence),
  };
  if (approvalMethods && evidenceMethods) {
    const captured = Object.freeze({ ...approvalMethods, ...evidenceMethods });
    return { recoveryApprovals: captured, recoveryEvidence: captured };
  }
  return { recoveryApprovals: approvalMethods && Object.freeze(approvalMethods),
    recoveryEvidence: evidenceMethods && Object.freeze(evidenceMethods) };
}

export function createAuthStagingOwnerBundle(input: {
  readonly store: AccountsStore;
  readonly control: ControlIdentityReconciliationPort;
  readonly ports?: AuthStagingOwnerPorts;
}): AuthStagingOwnerBundle {
  const source = input.ports ?? emptyPorts;
  if (Object.keys(source).some((key) => !["ownerOperationTarget", "recoveryApprovals", "recoveryEvidence", "reviewIssuerAvailability", "externalOwners",
    "workspaceBillingEnrollment", "retryAuthorityContextDigest"].includes(key))) throw new TypeError("auth_staging_owner_bundle_invalid");
  const target = source.ownerOperationTarget && Object.freeze({ ...source.ownerOperationTarget });
  if (target && (target.ownerKind !== "hosted-intents" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(target.ownerClientId) ||
    AUTH_STAGING_CLIENTS.some((client) => client.clientId === target.ownerClientId) ||
    !ownerDigest(target.targetBindingDigest) || Object.keys(target).sort().join(",") !== "ownerClientId,ownerKind,targetBindingDigest")) {
    throw new TypeError("auth_staging_owner_target_invalid");
  }
  const defaultReader = target && !source.recoveryApprovals && !source.recoveryEvidence
    ? createReviewedRecoveryApprovalAuthority({ store: input.store, target }) : undefined;
  const readers = captureReaders(defaultReader ? { recoveryApprovals: defaultReader, recoveryEvidence: defaultReader } : source);
  const reviewIssuerAvailability = source.reviewIssuerAvailability;
  if (reviewIssuerAvailability && (!target || !isReviewedRecoveryIssuerAvailabilityReader(reviewIssuerAvailability, target))) {
    throw new TypeError("auth_staging_review_issuer_unavailable");
  }
  if (source.externalOwners && Object.keys(source.externalOwners).some((kind) => !ownerKinds.includes(kind as typeof ownerKinds[number]))) {
    throw new TypeError("auth_staging_owner_ports_invalid");
  }
  const externalOwners: IdentityExternalOwnerPorts = Object.freeze(Object.fromEntries(ownerKinds.flatMap((kind) => {
    const port = source.externalOwners?.[kind];
    return port ? [[kind, Object.freeze({ kind: port.kind, ownerId: port.ownerId, ownerVersion: port.ownerVersion,
      assertReady: port.assertReady.bind(port), reconcile: port.reconcile.bind(port), read: port.read.bind(port) })]] : [];
  })));
  const authority = Object.freeze(createAccountsIdentityReconciliationAuthority(Object.freeze({ store: input.store, ...readers })));
  const reconciler = Object.freeze(createControlIdentityReconciler(Object.freeze({
    store: input.store, control: input.control, authority, externalOwners,
    ownerOperationTarget: target, ...readers, reviewIssuerAvailability,
  })));
  const ownerOperationReader = Object.freeze(createAccountsOwnerOperationReader(Object.freeze({
    store: input.store, control: input.control, authority, target, ...readers,
  })));
  const ports = Object.freeze({
    ...source, ownerOperationTarget: target, externalOwners, ...readers, reviewIssuerAvailability,
    identityMergeReconciler: reconciler,
    credentialUnlinkReconciler: reconciler,
    assertOwnerReadiness: reconciler.assertOwnerReadiness,
  });
  return Object.freeze({ store: input.store, authority, ownerOperationReader, ...readers, reviewIssuerAvailability, ports });
}

const emptyPorts: AuthStagingOwnerPorts = Object.freeze({});
type Pin = {
  readonly source: AuthStagingOwnerPorts;
  readonly fingerprint: readonly unknown[];
  store?: D1AccountsStore;
  bundle?: AuthStagingOwnerBundle;
  seam?: ReturnType<typeof createInProcessDeployControlSeam>;
  failed?: true;
};
const pins = new WeakMap<AuthStagingEnv, Pin>();
const defaults = new WeakMap<AuthStagingEnv, AuthStagingOwnerPorts>();

function defaultPorts(env: AuthStagingEnv): AuthStagingOwnerPorts {
  let source = defaults.get(env);
  if (!source) {
    const digest = env.TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST;
    const clientId = env.TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID;
    if (digest === undefined && clientId === undefined) source = emptyPorts;
    else {
      // A target is an operation-confusion pin, never a readiness assertion.
      source = Object.freeze({ ownerOperationTarget: Object.freeze({ ownerKind: "hosted-intents",
        ownerClientId: typeof clientId === "string" ? clientId : "", targetBindingDigest: typeof digest === "string" ? digest : "" }) });
    }
    defaults.set(env, source);
  }
  return source;
}

function fingerprint(env: AuthStagingEnv, source: AuthStagingOwnerPorts): readonly unknown[] {
  const target = source.ownerOperationTarget;
  return [env.TAKOSUMI_ACCOUNTS_DB, env.TAKOSUMI_CONTROL_DB, env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT,
    env.R2_ARTIFACTS, env.R2_SOURCE, env.R2_STATE, env.R2_BACKUPS, env.COORDINATION, env.RUN_OWNER, env.RUNNER,
    env.TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST, env.TAKOSUMI_VERSION_METADATA,
    env.TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID,
    env.TAKOSUMI_VERSION_METADATA && typeof env.TAKOSUMI_VERSION_METADATA === "object" && "id" in env.TAKOSUMI_VERSION_METADATA ? env.TAKOSUMI_VERSION_METADATA.id : undefined,
    env.TAKOSUMI_ENVIRONMENT, env.TAKOSUMI_ACCOUNTS_ISSUER, env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE, env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE,
    env.TAKOSUMI_AUTH_SOURCE_COMMIT, env.TAKOSUMI_AUTH_ARTIFACT_DIGEST, source,
    Object.keys(source).sort().join(","),
    target, target?.ownerKind, target?.ownerClientId, target?.targetBindingDigest,
    source.recoveryApprovals, source.recoveryApprovals?.findForOperation, source.recoveryApprovals?.read,
    source.recoveryEvidence, source.recoveryEvidence?.readRecoveryEvidence,
    source.recoveryEvidence?.readHistoricalRecoveryEvidence, source.recoveryEvidence?.readHistoricalRecoveryEvidenceByReviewRef,
    source.reviewIssuerAvailability, source.reviewIssuerAvailability?.isAvailable,
    source.externalOwners, source.externalOwners && Object.keys(source.externalOwners).sort().join(","),
    ...ownerKinds.flatMap((kind) => { const port = source.externalOwners?.[kind];
      return [port, port?.kind, port?.ownerId, port?.ownerVersion, port?.assertReady, port?.reconcile, port?.read]; }),
    source.workspaceBillingEnrollment, source.retryAuthorityContextDigest];
}

function assertPin(env: AuthStagingEnv, pin: Pin, source = pin.source): void {
  const current = fingerprint(env, source);
  if (pin.failed || current.length !== pin.fingerprint.length || current.some((value, i) => value !== pin.fingerprint[i])) {
    throw new TypeError("auth_staging_owner_bundle_changed");
  }
}

/** Records the attempted identity before construction, including failures.
 * A live environment cannot silently replace a reader, store or authority. */
export function authStagingOwnerBundle(env: AuthStagingEnv, supplied?: AuthStagingOwnerPorts): AuthStagingOwnerBundle {
  const source = supplied ?? defaultPorts(env);
  const existing = pins.get(env);
  if (existing) { assertPin(env, existing, source); return existing.bundle!; }
  const pin: Pin = { source, fingerprint: fingerprint(env, source) };
  pins.set(env, pin);
  try {
    if (typeof env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT !== "string" || !env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT.trim()) {
      throw new TypeError("auth_staging_owner_store_unavailable");
    }
    const store = new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
      schemaMode: "predeployed", sessionHashSalt: env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT!,
    });
    pin.store = store;
    const current = async () => {
      const port = (await authStagingControlOperations(env)).identityReconciliation;
      if (!port) throw new Error("auth_staging_control_identity_unavailable");
      return port;
    };
    const control: ControlIdentityReconciliationPort = {
      prepareMerge: async (input) => (await current()).prepareMerge(input),
      assertMergePlanCurrent: async (input) => (await current()).assertMergePlanCurrent(input),
      applyMerge: async (input) => (await current()).applyMerge(input),
      read: async (operationId) => (await current()).read(operationId),
      acknowledgeUnlink: async (input) => (await current()).acknowledgeUnlink(input),
      recover: async (input) => (await current()).recover(input),
    };
    Object.freeze(control);
    pin.bundle = createAuthStagingOwnerBundle({ store, control, ports: source });
    assertPin(env, pin);
    return pin.bundle;
  } catch (error) { pin.failed = true; throw error; }
}

export function authStagingControlOperations(env: AuthStagingEnv) {
  const bundle = pins.has(env) ? pins.get(env)!.bundle : authStagingOwnerBundle(env);
  const pin = pins.get(env)!;
  assertPin(env, pin);
  if (!bundle) throw new TypeError("auth_staging_owner_bundle_unavailable");
  pin.seam ??= createInProcessDeployControlSeam(env, { identityReconciliationAuthority: bundle.authority });
  return pin.seam.operations();
}
