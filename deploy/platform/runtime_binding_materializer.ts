import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  D1AccountsStore,
  resolveD1AccountsSchemaMode,
  type AccountsStore,
  type D1AccountsSchemaMode,
  type D1Database as AccountsD1Database,
} from "@takosjp/takosumi-accounts-service";
import { oidcClientActivationDigest } from "../../accounts/service/src/oidc-activation.ts";
import { oidcAllowedScopes } from "../../accounts/service/src/oidc-live-grant.ts";
import type { Capsule } from "../../contract/capsules.ts";
import type {
  InstallConfig,
  InstallConfigRuntimeBindingMaterialization,
} from "../../contract/install-configs.ts";
import { installExperienceOidcClient } from "../../contract/install-experience.ts";
import { stableJsonDigest } from "../../core/adapters/source/digest.ts";
import type {
  CanonicalCapsuleRunCredentialContextResult,
  CapsuleRunCredentialPhase,
} from "../../core/domains/deploy-control/run_credential_context.ts";
import { resolveCanonicalCapsuleRunCredentialContext } from "../../core/domains/deploy-control/run_credential_context.ts";
import { createCloudflareD1OpenTofuControlStore } from "../../worker/src/d1_opentofu_store.ts";
import type { D1Database as ControlD1Database } from "../../worker/src/bindings.ts";
import {
  deriveCapsulePublicOidcClientIdentity,
  derivePublicOidcClientId,
  registerCapsulePublicOidcClient,
} from "./accounts_oidc_client_registration.ts";

const AUTHORITY_CONTRACT = "takosumi.runtime-bindings/v1";
const PROFILE_CONTRACT_V1 = "takosumi.runtime-binding-profile/v1";
const PROFILE_CONTRACT_V2 = "takosumi.runtime-binding-profile/v2";
const BINDING_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface RuntimeBindingAuthority {
  readonly contract: typeof AUTHORITY_CONTRACT;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly phase: CapsuleRunCredentialPhase;
}

export interface RuntimeBindingControlLedger {
  resolveContext(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly runId: string;
    readonly phase: CapsuleRunCredentialPhase;
  }): Promise<CanonicalCapsuleRunCredentialContextResult>;
  getCapsule(id: string): Promise<Capsule | undefined>;
  getInstallConfig(id: string): Promise<InstallConfig | undefined>;
  getCapsuleExecutionAuthorityEpoch(id: string): Promise<number | undefined>;
}

export type RuntimeBindingAccountsLedger = Pick<
  AccountsStore,
  "findOidcClient" | "findOidcClientForCapsule" | "saveOidcClient"
>;

export interface RuntimeBindingMaterializerInput {
  readonly request: unknown;
  readonly resourceName: string;
  readonly scriptName: string;
  readonly publicOrigin: string;
  readonly bindings: readonly string[];
}

export interface TakosumiRuntimeBindingMaterializer {
  materializeRuntimeBindings(input: RuntimeBindingMaterializerInput): Promise<{
    readonly values: Readonly<Record<string, string>>;
    readonly rollbackReceipt?: string;
  }>;
  commitRuntimeBindings(input: RuntimeBindingMaterializerInput): Promise<void>;
  rollbackRuntimeBindings(input: {
    readonly request: unknown;
    readonly rollbackReceipt: string;
  }): Promise<void>;
}

export interface RuntimeBindingMaterializerCloudflareEnv {
  readonly TAKOSUMI_CONTROL_DB: ControlD1Database;
  readonly TAKOSUMI_CONTROL_D1_SCHEMA_MODE?: "bootstrap" | "predeployed";
  readonly TAKOSUMI_ACCOUNTS_DB: AccountsD1Database;
  readonly TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE?: D1AccountsSchemaMode;
  readonly TAKOSUMI_ACCOUNTS_ISSUER?: string;
  readonly TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET?: string;
  readonly TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY?: string;
}

export function createCloudflareTakosumiRuntimeBindingMaterializer(
  env: RuntimeBindingMaterializerCloudflareEnv,
): TakosumiRuntimeBindingMaterializer {
  const store = createCloudflareD1OpenTofuControlStore(
    env.TAKOSUMI_CONTROL_DB,
    { schemaMode: env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE ?? "bootstrap" },
  );
  const accounts = new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
    schemaMode: resolveD1AccountsSchemaMode(
      env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE,
    ),
  });
  return createTakosumiRuntimeBindingMaterializer({
    control: {
      resolveContext: (request) =>
        resolveCanonicalCapsuleRunCredentialContext(store, request),
      getCapsule: (id) => store.getCapsule(id),
      getInstallConfig: (id) => store.getInstallConfig(id),
      getCapsuleExecutionAuthorityEpoch: (id) =>
        store.getCapsuleExecutionAuthorityEpoch(id),
    },
    accounts,
    issuer: env.TAKOSUMI_ACCOUNTS_ISSUER ?? "",
    pairwiseSubjectSecret:
      env.TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET ?? "",
    derivationKey: env.TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY ?? "",
  });
}

export function createTakosumiRuntimeBindingMaterializer(input: {
  readonly control: RuntimeBindingControlLedger;
  readonly accounts: RuntimeBindingAccountsLedger;
  readonly issuer: string;
  readonly pairwiseSubjectSecret: string;
  readonly derivationKey: string;
  readonly clock?: () => Date;
}): TakosumiRuntimeBindingMaterializer {
  const issuer = exactHttpsOrigin(input.issuer);
  const pairwiseSubjectSecret = boundedSecret(
    input.pairwiseSubjectSecret,
    "pairwiseSubjectSecret",
  );
  const derivationKey = boundedSecret(input.derivationKey, "derivationKey");
  const clock = input.clock ?? (() => new Date());

  const resolve = async (
    call: RuntimeBindingMaterializerInput,
  ): Promise<ResolvedRuntimeBindingMaterialization> => {
    const authority = parseAuthority(call.request);
    const resourceName = exactIdentifier(call.resourceName, "resourceName");
    const scriptName = exactIdentifier(call.scriptName, "scriptName");
    const publicOrigin = exactHttpsOrigin(call.publicOrigin);
    const requestedBindings = exactBindingSet(call.bindings);

    const canonical = await input.control.resolveContext(authority);
    if (
      !canonical.ok ||
      canonical.context.workspaceId !== authority.workspaceId ||
      canonical.context.capsuleId !== authority.capsuleId ||
      canonical.context.runId !== authority.runId ||
      canonical.context.phase !== authority.phase ||
      (authority.phase === "apply" &&
        canonical.context.lifecycleIntent !== "provision") ||
      (authority.phase === "destroy" &&
        canonical.context.lifecycleIntent !== "destroy") ||
      !/^tsub_[A-Za-z0-9_-]{1,128}$/u.test(
        canonical.context.installingPrincipalId,
      )
    ) {
      invalid("runtime binding authority is not current");
    }

    const capsule = await input.control.getCapsule(authority.capsuleId);
    if (
      !capsule ||
      capsule.id !== authority.capsuleId ||
      capsule.workspaceId !== authority.workspaceId ||
      capsule.installingPrincipalId !== canonical.context.installingPrincipalId
    ) {
      invalid("runtime binding Capsule is not current");
    }
    const config = await input.control.getInstallConfig(capsule.installConfigId);
    if (
      !config ||
      config.id !== capsule.installConfigId ||
      config.workspaceId !== authority.workspaceId
    ) {
      invalid("runtime binding InstallConfig is not current");
    }
    const profile = exactProfile(config.runtimeBindingMaterialization);
    const declared = declaredBindings(profile);
    if (!sameStrings(requestedBindings, declared)) {
      invalid("runtime binding request differs from the DB-owned profile");
    }

    const values: Record<string, string> = {};
    for (const generated of profile.generatedSecrets ?? []) {
      values[generated.binding] = await derivedHexSecret(
        derivationKey,
        generatedSecretDerivationParts(
          profile.contract,
          authority,
          config.id,
          generated.binding,
        ),
      );
    }

    let oidc: ResolvedRuntimeBindingOidc | undefined;
    if (profile.oidcClient) {
      const callbackPath = exactCallbackPath(profile.oidcClient.callbackPath);
      const scopes = oidcAllowedScopes(profile.oidcClient.scopes);
      const grantDeclarations =
        config.installExperience?.projections?.filter(
          (projection) => projection.kind === "oidc_client",
        ) ?? [];
      const grant = installExperienceOidcClient(config.installExperience);
      if (
        grantDeclarations.length !== 1 ||
        Object.keys(grantDeclarations[0]!.variables).length !== 0 ||
        !grant ||
        grant.callbackPath !== callbackPath ||
        !sameStrings(oidcAllowedScopes(grant.scopes), scopes)
      ) {
        invalid("runtime binding OIDC grant differs from the DB-owned profile");
      }
      const clientId = await derivePublicOidcClientId(
        derivationKey,
        oidcClientDerivationParts(profile.contract, authority, config.id),
      );
      const identity = await deriveCapsulePublicOidcClientIdentity({
        capsule,
        installingPrincipalId: canonical.context
          .installingPrincipalId as TakosumiSubject,
        publicOrigin,
        callbackPath,
        clientId,
        pairwiseSubjectSecret,
      });
      values[profile.oidcClient.issuerBinding] = issuer;
      values[profile.oidcClient.clientIdBinding] = identity.clientId;
      values[profile.oidcClient.ownerSubjectBinding] = identity.ownerSubject;
      values[profile.oidcClient.redirectUriBinding] = identity.redirectUri;
      oidc = {
        installingPrincipalId: canonical.context
          .installingPrincipalId as TakosumiSubject,
        publicOrigin,
        callbackPath,
        scopes,
        clientId,
        identity,
      };
    }

    if (!sameStrings(Object.keys(values).sort(), declared)) {
      invalid("runtime materialization did not produce the exact binding set");
    }
    return {
      authority,
      resourceName,
      scriptName,
      publicOrigin,
      requestedBindings,
      capsule,
      config,
      profile,
      values,
      oidc,
    };
  };

  return {
    async materializeRuntimeBindings(call) {
      return { values: (await resolve(call)).values };
    },
    async commitRuntimeBindings(call) {
      const parsed = parseAuthority(call.request);
      if (parsed.phase !== "apply") {
        invalid("runtime binding commit requires Apply phase");
      }
      const resolved = await resolve(call);
      if (resolved.profile.contract === PROFILE_CONTRACT_V1 || !resolved.oidc) {
        return;
      }
      const executionAuthorityEpoch = exactExecutionAuthorityEpoch(
        await input.control.getCapsuleExecutionAuthorityEpoch(
          resolved.capsule.id,
        ),
      );
      const commitAuthorityDigest = await runtimeBindingCommitAuthorityDigest(
        resolved,
        executionAuthorityEpoch,
      );
      const confirmed = await resolve(call);
      if (!confirmed.oidc || confirmed.profile.contract !== PROFILE_CONTRACT_V2) {
        invalid("runtime binding commit authority changed during confirmation");
      }
      const confirmedExecutionAuthorityEpoch = exactExecutionAuthorityEpoch(
        await input.control.getCapsuleExecutionAuthorityEpoch(
          confirmed.capsule.id,
        ),
      );
      if (
        (await runtimeBindingCommitAuthorityDigest(
          confirmed,
          confirmedExecutionAuthorityEpoch,
        )) !== commitAuthorityDigest
      ) {
        invalid("runtime binding commit authority changed during confirmation");
      }
      const activationDigest = await oidcClientActivationDigest({
        workspaceId: confirmed.authority.workspaceId,
        capsuleId: confirmed.authority.capsuleId,
        executionAuthorityEpoch: confirmedExecutionAuthorityEpoch,
        installConfig: confirmed.config,
      });
      const registered = await registerCapsulePublicOidcClient({
        accounts: input.accounts,
        capsule: confirmed.capsule,
        installingPrincipalId: confirmed.oidc.installingPrincipalId,
        issuer,
        publicOrigin: confirmed.oidc.publicOrigin,
        callbackPath: confirmed.oidc.callbackPath,
        scopes: confirmed.oidc.scopes,
        clientId: confirmed.oidc.clientId,
        activationDigest,
        pairwiseSubjectSecret,
        clock,
      });
      if (
        registered.clientId !== confirmed.oidc.identity.clientId ||
        registered.ownerSubject !== confirmed.oidc.identity.ownerSubject ||
        registered.redirectUri !== confirmed.oidc.identity.redirectUri
      ) {
        invalid("runtime binding Accounts registration differs from derived values");
      }
    },
    async rollbackRuntimeBindings() {
      // Materialization is read-only and v2 commit happens only after upload.
      // Therefore an upload failure has no Accounts mutation to undo; the next
      // attempt re-reads and revalidates all authority before any commit.
    },
  };
}

interface ResolvedRuntimeBindingOidc {
  readonly installingPrincipalId: TakosumiSubject;
  readonly publicOrigin: string;
  readonly callbackPath: string;
  readonly scopes: readonly string[];
  readonly clientId: string;
  readonly identity: Awaited<
    ReturnType<typeof deriveCapsulePublicOidcClientIdentity>
  >;
}

interface ResolvedRuntimeBindingMaterialization {
  readonly authority: RuntimeBindingAuthority;
  readonly resourceName: string;
  readonly scriptName: string;
  readonly publicOrigin: string;
  readonly requestedBindings: readonly string[];
  readonly capsule: NonNullable<
    Awaited<ReturnType<RuntimeBindingControlLedger["getCapsule"]>>
  >;
  readonly config: InstallConfig;
  readonly profile: RuntimeBindingProfile;
  readonly values: Readonly<Record<string, string>>;
  readonly oidc?: ResolvedRuntimeBindingOidc;
}

type RuntimeBindingProfileContract =
  | typeof PROFILE_CONTRACT_V1
  | typeof PROFILE_CONTRACT_V2;

type RuntimeBindingProfile = Omit<
  InstallConfigRuntimeBindingMaterialization,
  "contract"
> & {
  readonly contract: RuntimeBindingProfileContract;
};

function parseAuthority(value: unknown): RuntimeBindingAuthority {
  if (!isRecord(value)) invalid("runtime binding authority is invalid");
  exactKeys(value, ["contract", "workspaceId", "capsuleId", "runId", "phase"]);
  if (value.contract !== AUTHORITY_CONTRACT) {
    invalid("runtime binding authority contract is invalid");
  }
  const phase = value.phase;
  if (phase !== "plan" && phase !== "apply" && phase !== "destroy") {
    invalid("runtime binding phase is invalid");
  }
  return {
    contract: AUTHORITY_CONTRACT,
    workspaceId: exactIdentifier(value.workspaceId, "workspaceId"),
    capsuleId: exactIdentifier(value.capsuleId, "capsuleId"),
    runId: exactIdentifier(value.runId, "runId"),
    phase,
  };
}

function exactProfile(
  value: InstallConfigRuntimeBindingMaterialization | undefined,
): RuntimeBindingProfile {
  if (!isRecord(value)) invalid("runtime binding profile is missing");
  exactKeys(value, ["contract"], [
    "generatedSecrets",
    "oidcClient",
    "runtimeSecretFile",
  ]);
  if (
    value.contract !== PROFILE_CONTRACT_V1 &&
    value.contract !== PROFILE_CONTRACT_V2
  ) {
    invalid("runtime binding profile is invalid");
  }
  if (
    (value.contract === PROFILE_CONTRACT_V1 &&
      !Array.isArray(value.generatedSecrets)) ||
    (value.generatedSecrets !== undefined &&
      (!Array.isArray(value.generatedSecrets) ||
        value.generatedSecrets.length > 16))
  ) {
    invalid("generated secret profile is invalid");
  }
  if (Array.isArray(value.generatedSecrets)) {
    for (const entry of value.generatedSecrets) {
      if (!isRecord(entry)) invalid("generated secret profile is invalid");
      exactKeys(entry, ["binding", "bytes", "encoding"]);
      exactBinding(entry.binding);
      if (entry.bytes !== 32 || entry.encoding !== "hex") {
        invalid("generated secret profile is invalid");
      }
    }
  }
  if (value.oidcClient !== undefined) {
    if (!isRecord(value.oidcClient)) invalid("OIDC binding profile is invalid");
    exactKeys(
      value.oidcClient,
      [
      "issuerBinding",
      "clientIdBinding",
      "ownerSubjectBinding",
      "redirectUriBinding",
        "callbackPath",
      ],
      ["scopes"],
    );
    for (const binding of oidcBindingNames(value.oidcClient)) exactBinding(binding);
    exactCallbackPath(value.oidcClient.callbackPath);
    oidcAllowedScopes(value.oidcClient.scopes);
  }
  declaredBindings(value);
  return value as RuntimeBindingProfile;
}

function declaredBindings(
  profile: RuntimeBindingProfile,
): string[] {
  const values = [
    ...(profile.generatedSecrets ?? []).map((entry) => entry.binding),
    ...(profile.oidcClient ? oidcBindingNames(profile.oidcClient) : []),
  ];
  return exactBindingSet(values);
}

function generatedSecretDerivationParts(
  profileContract: RuntimeBindingProfileContract,
  authority: RuntimeBindingAuthority,
  installConfigId: string,
  binding: string,
): readonly string[] {
  return profileContract === PROFILE_CONTRACT_V1
    ? [
        AUTHORITY_CONTRACT,
        authority.workspaceId,
        authority.capsuleId,
        installConfigId,
        binding,
      ]
    : [
        "takosumi.runtime-generated-secret/v2",
        authority.workspaceId,
        authority.capsuleId,
        binding,
      ];
}

function oidcClientDerivationParts(
  profileContract: RuntimeBindingProfileContract,
  authority: RuntimeBindingAuthority,
  installConfigId: string,
): readonly string[] {
  return profileContract === PROFILE_CONTRACT_V1
    ? [
        "takosumi-runtime-oidc-client-v1",
        authority.workspaceId,
        authority.capsuleId,
        installConfigId,
      ]
    : [
        "takosumi-runtime-oidc-client-v2",
        authority.workspaceId,
        authority.capsuleId,
      ];
}

async function runtimeBindingCommitAuthorityDigest(
  resolved: ResolvedRuntimeBindingMaterialization,
  executionAuthorityEpoch: number,
): Promise<string> {
  return await stableJsonDigest({
    contract: "takosumi.runtime-binding-commit-authority/v1",
    authority: resolved.authority,
    resourceName: resolved.resourceName,
    scriptName: resolved.scriptName,
    publicOrigin: resolved.publicOrigin,
    bindings: resolved.requestedBindings,
    capsule: resolved.capsule,
    executionAuthorityEpoch,
    installConfig: resolved.config,
    profile: resolved.profile,
  });
}

function exactExecutionAuthorityEpoch(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    invalid("runtime binding Capsule execution authority is not current");
  }
  return value;
}

function oidcBindingNames(
  value: NonNullable<InstallConfigRuntimeBindingMaterialization["oidcClient"]>,
): string[] {
  return [
    value.issuerBinding,
    value.clientIdBinding,
    value.ownerSubjectBinding,
    value.redirectUriBinding,
  ];
}

function exactBindingSet(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    invalid("runtime binding set is invalid");
  }
  const normalized = values.map(exactBinding).sort();
  if (new Set(normalized).size !== normalized.length) {
    invalid("runtime binding set contains duplicates");
  }
  return normalized;
}

function exactBinding(value: unknown): string {
  if (typeof value !== "string" || !BINDING_PATTERN.test(value)) {
    invalid("runtime binding name is invalid");
  }
  return value;
}

function exactIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function exactCallbackPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 1_024 ||
    /[\u0000-\u001f\u007f?#]/u.test(value)
  ) {
    invalid("OIDC callback path is invalid");
  }
  return value;
}

function exactHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("HTTPS origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    invalid("HTTPS origin is invalid");
  }
  return url.origin;
}

function boundedSecret(value: string, label: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 32 || bytes > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

async function derivedHexSecret(secret: string, parts: readonly string[]): Promise<string> {
  const bytes = await hmac(secret, parts);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, parts: readonly string[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(parts.join("\n"))),
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    invalid("runtime materialization object is not closed");
  }
}

function invalid(message: string): never {
  throw new TypeError(message);
}
