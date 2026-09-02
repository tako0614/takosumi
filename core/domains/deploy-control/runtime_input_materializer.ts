/**
 * Run-scoped sensitive provider inputs (host side).
 *
 * Some OpenTofu providers accept a run-scoped sensitive `map(string)` on their
 * provider block instead of persisting the values themselves. Takosumi mints
 * that map from the Capsule's manifest-gated runtime binding profile — the exact
 * `generatedSecrets[].binding` name set — and hands it to the runner as an
 * Apply-only dispatch value. The values are never written into the generated
 * root, the plan, `runs_inputs`, outputs, state, logs, audit rows, or a
 * credential-mint event.
 *
 * The sealing mechanism mirrors {@link ./runtime_secret_file_materializer.ts}:
 * one AES-GCM blob per Capsule, authenticated by an AAD that pins the owner and
 * the value-free profile digest, created once and reopened for every later Run
 * so a Capsule keeps stable material.
 *
 * The nonce is deliberately NOT random per Run. A provider derives its
 * apply-idempotency identity from the nonce, and that identity forces resource
 * replacement, so a per-Run nonce would propose a replacement on every plan.
 * The nonce here is a pure function of (Capsule authority, profile digest,
 * material key version, provider instance): it changes when the material
 * generation changes and at no other time.
 */

import type {
  InstallConfigRuntimeBindingMaterialization,
  RuntimeGeneratedSecretBinding,
} from "takosumi-contract/install-configs";
import type { SecretBoundaryCrypto } from "../../adapters/secret-store/memory.ts";
import type { SecretPartition } from "../../adapters/secret-store/types.ts";
import {
  stableJsonDigest,
  stableStringify,
} from "../../adapters/source/digest.ts";
import type { OpenTofuControlStore, StoredSecretBlob } from "./store.ts";

export const RUNTIME_INPUT_BUNDLE_MARKER = "[runtime-input-bundle]" as const;

const PROFILE_CONTRACT_V1 = "takosumi.runtime-binding-profile/v1";
const PROFILE_CONTRACT_V2 = "takosumi.runtime-binding-profile/v2";
const RUNNER_CONTRACT = "takosumi.runner-runtime-inputs/v1";
const BLOB_CONTRACT = "takosumi.runtime-provider-input/v1";
const NONCE_DOMAIN = "takosumi.provider-runtime-input-nonce/v1";
const BLOB_SCHEME = "runtime-input-aes-gcm/v1";
const NUL = "\u0000";

/**
 * Provider-side limits mirrored here so an oversized profile fails inside the
 * control plane instead of at the provider. Binding names use the stricter of
 * the two grammars (64 characters, not the 128 the host profile allows).
 */
export const RUNTIME_INPUT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const RUNTIME_INPUT_MAX_NAMES = 64;
export const RUNTIME_INPUT_MAX_VALUE_BYTES = 32768;
export const RUNTIME_INPUT_MAX_TOTAL_BYTES = 1024 * 1024;

const GENERATED_SECRET_BYTES = 32;

/** Capsule authority every runtime-input operation is scoped to. */
export interface RuntimeInputAuthority {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
}

/** Value-free description of what this Capsule may deliver. */
export interface RuntimeInputProfile {
  readonly profileDigest: `sha256:${string}`;
  /** Exact `generatedSecrets[].binding` set, sorted. Never a value. */
  readonly names: readonly string[];
}

export interface RuntimeInputProviderInstanceRequest
  extends RuntimeInputAuthority {
  /** Opaque `(moduleLocalName, rootAlias)` provider-instance identity. */
  readonly providerInstance: string;
}

export interface RunnerRuntimeInputsDispatch {
  readonly contract: typeof RUNNER_CONTRACT;
  readonly profileDigest: `sha256:${string}`;
  readonly nonce: string;
  readonly names: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Opaque control-plane carrier. JSON / string / inspection collapse to a marker
 * so an accidental log or ledger write cannot serialize the values; only the
 * explicit dispatch method returns them.
 */
export class RuntimeInputBundle {
  readonly #dispatch: RunnerRuntimeInputsDispatch;

  constructor(dispatch: RunnerRuntimeInputsDispatch) {
    this.#dispatch = dispatch;
  }

  get profileDigest(): `sha256:${string}` {
    return this.#dispatch.profileDigest;
  }

  get nonce(): string {
    return this.#dispatch.nonce;
  }

  get names(): readonly string[] {
    return [...this.#dispatch.names];
  }

  toRunnerDispatch(): RunnerRuntimeInputsDispatch {
    return {
      contract: RUNNER_CONTRACT,
      profileDigest: this.#dispatch.profileDigest,
      nonce: this.#dispatch.nonce,
      names: [...this.#dispatch.names],
      values: { ...this.#dispatch.values },
    };
  }

  toJSON(): typeof RUNTIME_INPUT_BUNDLE_MARKER {
    return RUNTIME_INPUT_BUNDLE_MARKER;
  }

  toString(): typeof RUNTIME_INPUT_BUNDLE_MARKER {
    return RUNTIME_INPUT_BUNDLE_MARKER;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): typeof RUNTIME_INPUT_BUNDLE_MARKER {
    return RUNTIME_INPUT_BUNDLE_MARKER;
  }
}

export interface RuntimeInputMaterializer {
  /** Value-free. The exact deliverable name set plus its digest. */
  profile(input: RuntimeInputAuthority): Promise<RuntimeInputProfile>;
  /**
   * Plan-stable nonce for one provider instance. Value-free: it never opens the
   * sealed material. Called at Plan (to bake the literal into the generated
   * root) and again at Apply (to fence that literal against live material).
   */
  nonce(input: RuntimeInputProviderInstanceRequest): Promise<string>;
  /** Apply-only. Opens the sealed material for one provider instance. */
  materialize(
    input: RuntimeInputProviderInstanceRequest & { readonly phase: "apply" },
  ): Promise<RuntimeInputBundle>;
  /** Best-effort retirement once the Capsule is destroyed. */
  retire(
    input: RuntimeInputAuthority & { readonly profileDigest: string },
  ): Promise<void>;
}

export function createRuntimeInputMaterializer(input: {
  readonly store: OpenTofuControlStore;
  readonly crypto: SecretBoundaryCrypto;
  readonly clock?: () => Date;
}): RuntimeInputMaterializer {
  const clock = input.clock ?? (() => new Date());

  const sealedMaterial = async (
    request: RuntimeInputAuthority,
  ): Promise<{
    readonly blob: StoredSecretBlob;
    readonly profileDigest: `sha256:${string}`;
    readonly declaration: RuntimeInputDeclaration;
    readonly partition: SecretPartition;
    readonly aad: string;
  }> => {
    const current = await currentProfile(input.store, request);
    if (current.capsule.status === "destroyed") {
      invalid("runtime input Capsule is destroyed");
    }
    const profileDigest = (await stableJsonDigest(
      current.declaration,
    )) as `sha256:${string}`;
    const ownerRef = runtimeInputOwnerRef(request.capsuleId);
    const partition = runtimeInputPartition(request.capsuleId);
    const aad = runtimeInputAad({
      ownerRef,
      workspaceId: request.workspaceId,
      capsuleId: request.capsuleId,
      profileDigest,
    });
    let blob = await input.store.getSecretBlob(ownerRef);
    if (!blob) {
      const content = generateRuntimeInputValues(current.declaration);
      const sealed = await input.crypto.seal(
        content,
        partition,
        new TextEncoder().encode(aad),
      );
      const candidate = runtimeInputBlob({
        ownerRef,
        workspaceId: request.workspaceId,
        partition,
        aad,
        sealed,
        createdAt: exactClock(clock()),
        crypto: input.crypto,
      });
      blob = (await input.store.createSecretBlobIfAbsent(candidate))
        ? candidate
        : await input.store.getSecretBlob(ownerRef);
    }
    if (!blob) invalid("runtime input storage acknowledgement was lost");
    assertRuntimeInputBlob({
      blob,
      ownerRef,
      workspaceId: request.workspaceId,
      partition,
      aad,
    });
    return {
      blob,
      profileDigest,
      declaration: current.declaration,
      partition,
      aad,
    };
  };

  return {
    async profile(request) {
      const current = await currentProfile(input.store, request);
      return {
        profileDigest: (await stableJsonDigest(
          current.declaration,
        )) as `sha256:${string}`,
        names: current.declaration.generatedSecrets.map(
          (entry) => entry.binding,
        ),
      };
    },
    async nonce(request) {
      const material = await sealedMaterial(request);
      return await runtimeInputNonce({
        workspaceId: request.workspaceId,
        capsuleId: request.capsuleId,
        installConfigId: request.installConfigId,
        profileDigest: material.profileDigest,
        materialKeyVersion: material.blob.keyVersion,
        providerInstance: exactProviderInstance(request.providerInstance),
      });
    },
    async materialize(request) {
      if (request.phase !== "apply") {
        invalid("runtime inputs are materialized only for apply");
      }
      const material = await sealedMaterial(request);
      let content: string;
      try {
        content = await input.crypto.open(
          base64ToBytes(material.blob.ciphertext),
          material.partition,
          new TextEncoder().encode(material.aad),
        );
      } catch {
        invalid("sealed runtime inputs could not be opened");
      }
      const values = exactRuntimeInputValues(content, material.declaration);
      return new RuntimeInputBundle({
        contract: RUNNER_CONTRACT,
        profileDigest: material.profileDigest,
        nonce: await runtimeInputNonce({
          workspaceId: request.workspaceId,
          capsuleId: request.capsuleId,
          installConfigId: request.installConfigId,
          profileDigest: material.profileDigest,
          materialKeyVersion: material.blob.keyVersion,
          providerInstance: exactProviderInstance(request.providerInstance),
        }),
        names: Object.keys(values).sort(),
        values,
      });
    },
    async retire(request) {
      const current = await currentProfile(input.store, request);
      if (current.capsule.status !== "destroyed") {
        invalid("runtime inputs retire only after Capsule is destroyed");
      }
      const profileDigest = await stableJsonDigest(current.declaration);
      if (request.profileDigest !== profileDigest) {
        invalid("runtime input retirement profile is stale");
      }
      const ownerRef = runtimeInputOwnerRef(request.capsuleId);
      const partition = runtimeInputPartition(request.capsuleId);
      const aad = runtimeInputAad({
        ownerRef,
        workspaceId: request.workspaceId,
        capsuleId: request.capsuleId,
        profileDigest,
      });
      const blob = await input.store.getSecretBlob(ownerRef);
      if (!blob) return;
      assertRuntimeInputBlob({
        blob,
        ownerRef,
        workspaceId: request.workspaceId,
        partition,
        aad,
      });
      await input.store.deleteSecretBlob(ownerRef);
    },
  };
}

/**
 * Value-free profile projection the nonce and the AAD bind to. Only the
 * generated-secret declarations participate: an unrelated OIDC or runtime
 * secret-file edit must not rotate a provider's apply-idempotency identity.
 */
interface RuntimeInputDeclaration {
  readonly contract: typeof PROFILE_CONTRACT_V1 | typeof PROFILE_CONTRACT_V2;
  readonly generatedSecrets: readonly RuntimeGeneratedSecretBinding[];
}

async function currentProfile(
  store: OpenTofuControlStore,
  request: RuntimeInputAuthority,
) {
  const capsule = await store.getCapsule(request.capsuleId);
  if (
    !capsule ||
    capsule.workspaceId !== request.workspaceId ||
    capsule.installConfigId !== request.installConfigId
  ) {
    invalid("runtime input Capsule authority is not current");
  }
  const config = await store.getInstallConfig(request.installConfigId);
  if (
    !config ||
    config.id !== capsule.installConfigId ||
    (config.workspaceId !== undefined &&
      config.workspaceId !== request.workspaceId)
  ) {
    invalid("runtime input InstallConfig authority is not current");
  }
  return {
    capsule,
    declaration: exactRuntimeInputProfile(config.runtimeBindingMaterialization),
  };
}

export function exactRuntimeInputProfile(
  profile: InstallConfigRuntimeBindingMaterialization | undefined,
): RuntimeInputDeclaration {
  if (
    !isRecord(profile) ||
    (profile.contract !== PROFILE_CONTRACT_V1 &&
      profile.contract !== PROFILE_CONTRACT_V2)
  ) {
    invalid("runtime input profile is missing");
  }
  const generatedSecrets = profile.generatedSecrets;
  if (!Array.isArray(generatedSecrets) || generatedSecrets.length === 0) {
    invalid("runtime input profile declares no generated secret binding");
  }
  if (generatedSecrets.length > RUNTIME_INPUT_MAX_NAMES) {
    invalid("runtime input profile declares too many bindings");
  }
  const names: string[] = [];
  for (const entry of generatedSecrets) {
    if (
      !isRecord(entry) ||
      typeof entry.binding !== "string" ||
      !RUNTIME_INPUT_NAME_PATTERN.test(entry.binding) ||
      entry.bytes !== GENERATED_SECRET_BYTES ||
      entry.encoding !== "hex"
    ) {
      invalid("runtime input generated secret declaration is invalid");
    }
    names.push(entry.binding);
  }
  if (new Set(names).size !== names.length) {
    invalid("runtime input binding names must be unique");
  }
  return {
    contract: profile.contract,
    generatedSecrets: (generatedSecrets as readonly RuntimeGeneratedSecretBinding[])
      .map((entry) => ({
        binding: entry.binding,
        bytes: entry.bytes,
        encoding: entry.encoding,
      }))
      .sort((left, right) => left.binding.localeCompare(right.binding)),
  };
}

/**
 * Deterministic per (Capsule authority, profile, material generation, provider
 * instance). 32 digest bytes render as 43 unpadded base64url characters, inside
 * the 22..128 range a provider accepts and well above its 16-byte floor.
 */
export async function runtimeInputNonce(input: {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly profileDigest: string;
  readonly materialKeyVersion: number;
  readonly providerInstance: string;
}): Promise<string> {
  const preimage = stableStringify({
    domain: NONCE_DOMAIN,
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    installConfigId: input.installConfigId,
    profileDigest: input.profileDigest,
    materialKeyVersion: input.materialKeyVersion,
    providerInstance: input.providerInstance,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage)),
  );
  return base64UrlNoPad(digest);
}

/** Opaque provider-instance identity: `moduleLocalName` + NUL + `rootAlias`. */
export function runtimeInputProviderInstance(binding: {
  readonly moduleLocalName: string;
  readonly rootAlias?: string;
}): string {
  return `${binding.moduleLocalName}${NUL}${binding.rootAlias ?? ""}`;
}

function exactProviderInstance(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    invalid("runtime input provider instance is invalid");
  }
  return value;
}

function generateRuntimeInputValues(
  declaration: RuntimeInputDeclaration,
): string {
  const values: Record<string, string> = {};
  for (const entry of declaration.generatedSecrets) {
    const bytes = new Uint8Array(entry.bytes);
    crypto.getRandomValues(bytes);
    values[entry.binding] = bytesToHex(bytes);
  }
  return stableStringify(values);
}

function exactRuntimeInputValues(
  content: string,
  declaration: RuntimeInputDeclaration,
): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    invalid("sealed runtime inputs are invalid");
  }
  if (!isRecord(parsed)) invalid("sealed runtime inputs are invalid");
  const declared = declaration.generatedSecrets
    .map((entry) => entry.binding)
    .sort();
  const actual = Object.keys(parsed).sort();
  if (
    actual.length !== declared.length ||
    actual.some((name, index) => name !== declared[index])
  ) {
    invalid("sealed runtime inputs differ from their profile");
  }
  let totalBytes = 0;
  for (const name of actual) {
    const value = parsed[name];
    if (typeof value !== "string" || value.length === 0) {
      invalid("sealed runtime inputs differ from their profile");
    }
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > RUNTIME_INPUT_MAX_VALUE_BYTES || value.includes(NUL)) {
      invalid("sealed runtime input value exceeds the provider limit");
    }
    totalBytes += bytes;
  }
  if (totalBytes > RUNTIME_INPUT_MAX_TOTAL_BYTES) {
    invalid("sealed runtime inputs exceed the provider total limit");
  }
  return Object.fromEntries(
    actual.map((name) => [name, parsed[name] as string]),
  );
}

function assertRuntimeInputBlob(input: {
  readonly blob: StoredSecretBlob;
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly partition: SecretPartition;
  readonly aad: string;
}): void {
  if (
    input.blob.connectionId !== input.ownerRef ||
    input.blob.workspaceId !== input.workspaceId ||
    input.blob.kind !== input.partition ||
    input.blob.encryptedDek !== `${BLOB_SCHEME}/${input.partition}` ||
    input.blob.aad !== input.aad
  ) {
    invalid("runtime input profile or owner fence changed");
  }
}

function runtimeInputBlob(input: {
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly partition: SecretPartition;
  readonly aad: string;
  readonly sealed: Uint8Array;
  readonly createdAt: string;
  readonly crypto: SecretBoundaryCrypto;
}): StoredSecretBlob {
  return {
    id: `secret_${input.ownerRef}`,
    connectionId: input.ownerRef,
    workspaceId: input.workspaceId,
    kind: input.partition,
    ciphertext: bytesToBase64(input.sealed),
    encryptedDek: `${BLOB_SCHEME}/${input.partition}`,
    nonce: bytesToBase64(input.sealed.slice(0, 12)),
    aad: input.aad,
    keyVersion: input.crypto.keyVersion?.(input.partition) ?? 1,
    createdAt: input.createdAt,
  };
}

function runtimeInputAad(input: {
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly profileDigest: string;
}): string {
  return stableStringify({
    contract: BLOB_CONTRACT,
    ownerRef: input.ownerRef,
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    profileDigest: input.profileDigest,
  });
}

function runtimeInputOwnerRef(capsuleId: string): string {
  exactIdentifier(capsuleId, "capsuleId");
  return `runtime_input_${capsuleId}`;
}

function runtimeInputPartition(capsuleId: string): SecretPartition {
  exactIdentifier(capsuleId, "capsuleId");
  return `runtime-input:${capsuleId}`;
}

function exactIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    invalid(`runtime input ${label} is invalid`);
  }
}

function exactClock(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalid("runtime input clock is invalid");
  }
  return value.toISOString();
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlNoPad(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new TypeError(message);
}
