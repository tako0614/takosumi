import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { derivePairwiseSubject } from "../../accounts/service/src/subject.ts";
import { D1AccountsStore } from "../../accounts/service/src/d1-store.ts";
import { oidcAllowedScopes } from "../../accounts/service/src/oidc-live-grant.ts";
import type {
  AccountsStore,
  OidcClientRecord,
} from "../../accounts/service/src/store.ts";
import type { Capsule } from "../../contract/capsules.ts";
import type {
  InstallConfig,
  InstallConfigRuntimeBindingMaterialization,
} from "../../contract/install-configs.ts";
import { installExperienceOidcClient } from "../../contract/install-experience.ts";
import type {
  CanonicalCapsuleRunCredentialContextResult,
  CapsuleRunCredentialPhase,
} from "../../core/domains/deploy-control/run_credential_context.ts";
import { resolveCanonicalCapsuleRunCredentialContext } from "../../core/domains/deploy-control/run_credential_context.ts";
import { createCloudflareD1OpenTofuControlStore } from "../../worker/src/d1_opentofu_store.ts";
import type { D1Database as ControlD1Database } from "../../worker/src/bindings.ts";

const AUTHORITY_CONTRACT = "takosumi.runtime-bindings/v1";
const PROFILE_CONTRACT = "takosumi.runtime-binding-profile/v1";
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
  getCapsule(id: string): Promise<
    | Pick<Capsule, "id" | "workspaceId" | "name" | "installConfigId">
    | undefined
  >;
  getInstallConfig(id: string): Promise<InstallConfig | undefined>;
  putInstallConfig(config: InstallConfig): Promise<InstallConfig>;
}

export type RuntimeBindingAccountsLedger = Pick<
  AccountsStore,
  "findOidcClient" | "findOidcClientForCapsule" | "saveOidcClient"
>;

export interface TakosumiRuntimeBindingMaterializer {
  materializeRuntimeBindings(input: {
    readonly request: unknown;
    readonly resourceName: string;
    readonly scriptName: string;
    readonly publicOrigin: string;
    readonly bindings: readonly string[];
  }): Promise<{
    readonly values: Readonly<Record<string, string>>;
    readonly rollbackReceipt?: string;
  }>;
  rollbackRuntimeBindings(input: {
    readonly request: unknown;
    readonly rollbackReceipt: string;
  }): Promise<void>;
}

export interface RuntimeBindingMaterializerCloudflareEnv {
  readonly TAKOSUMI_CONTROL_DB: ControlD1Database;
  readonly TAKOSUMI_CONTROL_D1_SCHEMA_MODE?: "bootstrap" | "predeployed";
  readonly TAKOSUMI_ACCOUNTS_DB: import("@takosjp/takosumi-accounts-service").D1Database;
  readonly TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE?: import("@takosjp/takosumi-accounts-service").D1AccountsSchemaMode;
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
  return createTakosumiRuntimeBindingMaterializer({
    control: {
      resolveContext: (request) =>
        resolveCanonicalCapsuleRunCredentialContext(store, request),
      getCapsule: (id) => store.getCapsule(id),
      getInstallConfig: (id) => store.getInstallConfig(id),
      putInstallConfig: (config) => store.putInstallConfig(config),
    },
    accounts: new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
      schemaMode: env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE ?? "bootstrap",
    }),
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

  return {
    async materializeRuntimeBindings(call) {
      const authority = parseAuthority(call.request);
      exactIdentifier(call.resourceName, "resourceName");
      exactIdentifier(call.scriptName, "scriptName");
      const publicOrigin = exactHttpsOrigin(call.publicOrigin);
      const requestedBindings = exactBindingSet(call.bindings);

      const canonical = await input.control.resolveContext(authority);
      if (
        !canonical.ok ||
        canonical.context.workspaceId !== authority.workspaceId ||
        canonical.context.capsuleId !== authority.capsuleId ||
        canonical.context.runId !== authority.runId ||
        canonical.context.phase !== authority.phase ||
        canonical.context.lifecycleIntent !== "provision" ||
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
        capsule.workspaceId !== authority.workspaceId
      ) {
        invalid("runtime binding Capsule is not current");
      }
      let config = await input.control.getInstallConfig(
        capsule.installConfigId,
      );
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
        values[generated.binding] = await derivedHexSecret(derivationKey, [
          AUTHORITY_CONTRACT,
          authority.workspaceId,
          authority.capsuleId,
          config.id,
          generated.binding,
        ]);
      }

      if (profile.oidcClient) {
        const callbackPath = exactCallbackPath(profile.oidcClient.callbackPath);
        const scopes = oidcAllowedScopes(profile.oidcClient.scopes);
        const grant = installExperienceOidcClient(config.installExperience);
        if (
          !grant ||
          grant.callbackPath !== callbackPath ||
          !sameStrings(oidcAllowedScopes(grant.scopes), scopes)
        ) {
          const now = clock();
          if (!Number.isFinite(now.getTime())) invalid("clock is invalid");
          config = await input.control.putInstallConfig({
            ...config,
            installExperience: {
              ...config.installExperience,
              projections: [
                ...(config.installExperience?.projections ?? []).filter(
                  (projection) => projection.kind !== "oidc_client",
                ),
                {
                  kind: "oidc_client",
                  variables: {},
                  callbackPath,
                  scopes,
                },
              ],
            },
            updatedAt: now.toISOString(),
          });
        }
        const clientId = `tko_${await derivedBase64Url(derivationKey, [
          "takosumi-runtime-oidc-client-v1",
          authority.workspaceId,
          authority.capsuleId,
          config.id,
        ])}`;
        const redirectUri = new URL(callbackPath, `${publicOrigin}/`).href;
        const existingForCapsule = await input.accounts.findOidcClientForCapsule(
          capsule.id,
        );
        if (
          existingForCapsule &&
          existingForCapsule.clientId !== clientId
        ) {
          invalid("Capsule is already bound to another OIDC client");
        }
        const existing = await input.accounts.findOidcClient(clientId);
        if (existing && existing.capsuleId !== capsule.id) {
          invalid("OIDC client is already bound to another Capsule");
        }
        const ownerSubject = await derivePairwiseSubject({
          secret: pairwiseSubjectSecret,
          takosumiSubject: canonical.context
            .installingPrincipalId as TakosumiSubject,
          clientId: `${capsule.name}:${capsule.id}:${clientId}`,
        });
        const now = clock().getTime();
        if (!Number.isSafeInteger(now) || now <= 0) invalid("clock is invalid");
        const registration: OidcClientRecord = {
          clientId,
          capsuleId: capsule.id,
          namespacePath: "identity.oidc",
          issuerUrl: issuer,
          redirectUris: [redirectUri],
          allowedScopes: scopes,
          subjectMode: "pairwise",
          tokenEndpointAuthMethod: "none",
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await input.accounts.saveOidcClient(registration);
        values[profile.oidcClient.issuerBinding] = issuer;
        values[profile.oidcClient.clientIdBinding] = clientId;
        values[profile.oidcClient.ownerSubjectBinding] = ownerSubject;
        values[profile.oidcClient.redirectUriBinding] = redirectUri;
      }

      if (!sameStrings(Object.keys(values).sort(), declared)) {
        invalid("runtime materialization did not produce the exact binding set");
      }
      return { values };
    },
    async rollbackRuntimeBindings() {
      // Values and deterministic OIDC registration are shared by immutable
      // Worker Versions. A failed upload has no mutation-specific authority to
      // delete them; the next attempt re-reads and revalidates everything.
    },
  };
}

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
): InstallConfigRuntimeBindingMaterialization {
  if (!isRecord(value)) invalid("runtime binding profile is missing");
  exactKeys(value, ["contract"], ["generatedSecrets", "oidcClient"]);
  if (value.contract !== PROFILE_CONTRACT) invalid("runtime binding profile is invalid");
  if (!Array.isArray(value.generatedSecrets) || value.generatedSecrets.length > 16) {
    invalid("generated secret profile is invalid");
  }
  for (const entry of value.generatedSecrets) {
    if (!isRecord(entry)) invalid("generated secret profile is invalid");
    exactKeys(entry, ["binding", "bytes", "encoding"]);
    exactBinding(entry.binding);
    if (entry.bytes !== 32 || entry.encoding !== "hex") {
      invalid("generated secret profile is invalid");
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
  return value;
}

function declaredBindings(
  profile: InstallConfigRuntimeBindingMaterialization,
): string[] {
  const values = [
    ...(profile.generatedSecrets ?? []).map((entry) => entry.binding),
    ...(profile.oidcClient ? oidcBindingNames(profile.oidcClient) : []),
  ];
  return exactBindingSet(values);
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

async function derivedBase64Url(secret: string, parts: readonly string[]): Promise<string> {
  const bytes = await hmac(secret, parts);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
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
