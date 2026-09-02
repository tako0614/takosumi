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
 * There are two value lanes, and a host picks exactly one. Without a host
 * derivation the values are fresh randomness sealed the way
 * {@link ./runtime_secret_file_materializer.ts} seals its file: one AES-GCM
 * blob per Capsule, authenticated by an AAD that pins the owner and the
 * value-free profile digest, created once and reopened for every later Run. A
 * host that ALSO materializes the same `generatedSecrets` profile elsewhere
 * injects that derivation instead, and then nothing is sealed: the values are a
 * pure function of the host key and the profile, so both lanes necessarily mint
 * the same bytes for the same Capsule.
 *
 * A profile change (the Capsule's manifest adds or renames a generated secret)
 * retires the previous sealed generation and seals a new one. Fencing it off
 * instead would leave the Capsule unable to plan OR destroy, with no recovery
 * path.
 *
 * The nonce is deliberately NOT random per Run. A provider derives its
 * apply-idempotency identity from the nonce, and that identity forces resource
 * replacement, so a per-Run nonce would propose a replacement on every plan.
 * The nonce here is a pure function of (workspace, Capsule, profile digest,
 * material generation, provider instance): it changes when the material
 * generation changes and at no other time. The material generation is a digest
 * of the sealed ciphertext, so re-sealing — the only way the values can move —
 * always rotates it, and nothing else does. `installConfigId` is deliberately
 * NOT part of the preimage: a repo re-sync can repoint a Capsule at a
 * content-identical InstallConfig, and rotating the nonce there would force a
 * provider-side replacement of resources whose content never changed.
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
/**
 * Derivation-part prefixes shared with the private runtime-binding lane. They
 * are the preimage of that lane's generated-secret HMAC and must never drift:
 * both lanes materialize the SAME `generatedSecrets` profile.
 */
const RUNTIME_BINDING_AUTHORITY_CONTRACT = "takosumi.runtime-bindings/v1";
const GENERATED_SECRET_DERIVATION_V2 = "takosumi.runtime-generated-secret/v2";
const NUL = "\u0000";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

/**
 * Provider-side limits mirrored here so an oversized profile fails inside the
 * control plane instead of at the provider. Binding names use the stricter of
 * the two grammars (64 characters, not the 128 the host profile allows), and
 * the binding count uses the runtime binding profile's own cap of 16 rather
 * than the provider's 64: one profile is one value set, and the private
 * Takoserver lane already refuses to materialize a wider one.
 */
export const RUNTIME_INPUT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const RUNTIME_INPUT_MAX_NAMES = 16;
export const RUNTIME_INPUT_MAX_VALUE_BYTES = 32768;
export const RUNTIME_INPUT_MAX_TOTAL_BYTES = 1024 * 1024;
/**
 * Runner redaction floor. A shorter value could not be stripped out of runner
 * stdout/stderr, so no lane is allowed to mint one.
 */
export const RUNTIME_INPUT_MIN_VALUE_LENGTH = 8;

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

/**
 * Host-supplied source for one generated-secret binding's value.
 *
 * A host that ALSO materializes the same `generatedSecrets` profile through
 * another lane (the private Takoserver runtime-binding lane derives every
 * binding from a host key) must inject that derivation here, or the deployed
 * workload and the provider would each hold a different value for the same
 * binding. Without one, values are fresh randomness sealed per Capsule.
 */
export type RuntimeInputValueSource = (input: {
  readonly profileContract: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly binding: string;
  readonly bytes: number;
}) => Promise<string>;

/**
 * The private runtime-binding lane's generated-secret derivation, expressed
 * as a value source.
 *
 * The preimage parts are the ones that lane uses, so the two produce
 * byte-identical values for the same profile under the same host key. Core
 * imports nothing from the private lane; only these parts are shared, and
 * `tests/deploy/platform/runtime_binding_materializer_test.ts` pins the
 * equality against the real implementation.
 */
export function runtimeInputDerivedValueSource(
  derivationKey: string,
): RuntimeInputValueSource {
  const key = boundedDerivationKey(derivationKey);
  return async (request) => {
    if (request.bytes !== GENERATED_SECRET_BYTES) {
      invalid("runtime input derivation supports 32-byte generated secrets");
    }
    return bytesToHex(
      await hmacSha256(key, generatedSecretDerivationParts(request)),
    );
  };
}

function generatedSecretDerivationParts(request: {
  readonly profileContract: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installConfigId: string;
  readonly binding: string;
}): readonly string[] {
  return request.profileContract === PROFILE_CONTRACT_V1
    ? [
        RUNTIME_BINDING_AUTHORITY_CONTRACT,
        request.workspaceId,
        request.capsuleId,
        request.installConfigId,
        request.binding,
      ]
    : [
        GENERATED_SECRET_DERIVATION_V2,
        request.workspaceId,
        request.capsuleId,
        request.binding,
      ];
}

async function hmacSha256(
  secret: string,
  parts: readonly string[],
): Promise<Uint8Array> {
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

function boundedDerivationKey(value: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 32 || bytes > 4096 || CONTROL_CHARACTER_PATTERN.test(value)) {
    invalid("runtime input derivation key is invalid");
  }
  return value;
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
  /**
   * Best-effort retirement once the Capsule is destroyed. `profileDigest` is
   * optional: supplying it fences the caller's pinned generation against the
   * current one, omitting it retires whatever this Capsule still owns.
   */
  retire(
    input: RuntimeInputAuthority & { readonly profileDigest?: string },
  ): Promise<void>;
}

export function createRuntimeInputMaterializer(input: {
  readonly store: OpenTofuControlStore;
  readonly crypto: SecretBoundaryCrypto;
  /**
   * Optional host derivation for generated-secret values. Supply it whenever a
   * second lane materializes the same profile, so both mint the same bytes.
   */
  readonly values?: RuntimeInputValueSource;
  readonly clock?: () => Date;
}): RuntimeInputMaterializer {
  const clock = input.clock ?? (() => new Date());

  /**
   * The generation identity of derived material.
   *
   * Value-free by construction: it digests the derivation PARTS, not the
   * values, so it moves exactly when the derived values would move and never
   * requires opening (or computing) a secret to answer `nonce()`.
   */
  const derivedGeneration = async (
    declaration: RuntimeInputDeclaration,
    authority: RuntimeInputAuthority,
  ): Promise<string> => {
    const preimage = stableStringify({
      domain: `${NONCE_DOMAIN}#derived-generation`,
      parts: declaration.generatedSecrets.map((entry) =>
        generatedSecretDerivationParts({
          profileContract: declaration.contract,
          workspaceId: authority.workspaceId,
          capsuleId: authority.capsuleId,
          installConfigId: authority.installConfigId,
          binding: entry.binding,
        }),
      ),
    });
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage)),
    );
    return `sha256:${bytesToHex(digest)}`;
  };

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
    if (blob) {
      assertRuntimeInputOwner({
        blob,
        ownerRef,
        workspaceId: request.workspaceId,
        partition,
      });
      if (blob.aad !== aad) {
        // The Capsule's manifest changed the deliverable name set, so the
        // sealed material no longer answers the current profile. Retire it and
        // seal a new generation rather than bricking every later plan — and
        // every later destroy — behind a fence with no recovery path. The
        // nonce rotates with the new generation, which is exactly the
        // replacement semantics a provider expects from rotated material.
        await input.store.deleteSecretBlob(ownerRef);
        blob = undefined;
      }
    }
    if (!blob) {
      const content = await generateRuntimeInputValues(
        current.declaration,
        request,
        input.values,
      );
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
      const providerInstance = exactProviderInstance(request.providerInstance);
      if (input.values) {
        const current = await currentProfile(input.store, request);
        if (current.capsule.status === "destroyed") {
          invalid("runtime input Capsule is destroyed");
        }
        return await runtimeInputNonce({
          workspaceId: request.workspaceId,
          capsuleId: request.capsuleId,
          profileDigest: (await stableJsonDigest(
            current.declaration,
          )) as `sha256:${string}`,
          materialGeneration: await derivedGeneration(
            current.declaration,
            request,
          ),
          providerInstance,
        });
      }
      const material = await sealedMaterial(request);
      return await runtimeInputNonce({
        workspaceId: request.workspaceId,
        capsuleId: request.capsuleId,
        profileDigest: material.profileDigest,
        materialGeneration: await materialGenerationDigest(material.blob),
        providerInstance: exactProviderInstance(request.providerInstance),
      });
    },
    async materialize(request) {
      if (request.phase !== "apply") {
        invalid("runtime inputs are materialized only for apply");
      }
      const providerInstance = exactProviderInstance(request.providerInstance);
      if (input.values) {
        // Host derivation lane: the values ARE a pure function of the host key
        // and the profile, so nothing is sealed. Sealing here would pin one
        // generation and let the other lane drift away from it silently.
        const current = await currentProfile(input.store, request);
        if (current.capsule.status === "destroyed") {
          invalid("runtime input Capsule is destroyed");
        }
        const profileDigest = (await stableJsonDigest(
          current.declaration,
        )) as `sha256:${string}`;
        const values = exactRuntimeInputValues(
          await generateRuntimeInputValues(
            current.declaration,
            request,
            input.values,
          ),
          current.declaration,
        );
        return new RuntimeInputBundle({
          contract: RUNNER_CONTRACT,
          profileDigest,
          nonce: await runtimeInputNonce({
            workspaceId: request.workspaceId,
            capsuleId: request.capsuleId,
            profileDigest,
            materialGeneration: await derivedGeneration(
              current.declaration,
              request,
            ),
            providerInstance,
          }),
          names: Object.keys(values).sort(),
          values,
        });
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
          profileDigest: material.profileDigest,
          materialGeneration: await materialGenerationDigest(material.blob),
          providerInstance,
        }),
        names: Object.keys(values).sort(),
        values,
      });
    },
    async retire(request) {
      const capsule = await input.store.getCapsule(request.capsuleId);
      if (
        !capsule ||
        capsule.workspaceId !== request.workspaceId ||
        capsule.installConfigId !== request.installConfigId
      ) {
        invalid("runtime input Capsule authority is not current");
      }
      if (capsule.status !== "destroyed") {
        invalid("runtime inputs retire only after Capsule is destroyed");
      }
      // A caller that names a generation must name the current one. A caller
      // with no descriptor (a teardown that never wired inputs, or a Capsule
      // whose profile has since become unreadable) still retires the material:
      // the owner fence below is what proves whose row this is.
      if (request.profileDigest !== undefined) {
        const current = await currentProfile(input.store, request);
        if (request.profileDigest !== (await stableJsonDigest(current.declaration))) {
          invalid("runtime input retirement profile is stale");
        }
      }
      const ownerRef = runtimeInputOwnerRef(request.capsuleId);
      const partition = runtimeInputPartition(request.capsuleId);
      const blob = await input.store.getSecretBlob(ownerRef);
      if (!blob) return;
      assertRuntimeInputOwner({
        blob,
        ownerRef,
        workspaceId: request.workspaceId,
        partition,
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
 * Deterministic per (workspace, Capsule, profile, material generation, provider
 * instance). 32 digest bytes render as 43 unpadded base64url characters, inside
 * the 22..128 range a provider accepts and well above its 16-byte floor.
 */
export async function runtimeInputNonce(input: {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly profileDigest: string;
  /** Digest of the sealed ciphertext: it moves if and only if values move. */
  readonly materialGeneration: string;
  readonly providerInstance: string;
}): Promise<string> {
  const preimage = stableStringify({
    domain: NONCE_DOMAIN,
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    profileDigest: input.profileDigest,
    materialGeneration: input.materialGeneration,
    providerInstance: input.providerInstance,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage)),
  );
  return base64UrlNoPad(digest);
}

/**
 * The sealed material's generation identity.
 *
 * A key-version alone is fixed at blob creation, so a store restore or a wipe
 * that re-mints values under the same key would keep the old nonce while the
 * values changed — the provider would then keep the preparation it made from
 * the retired values. Digesting the ciphertext ties the nonce to the actual
 * bytes: any re-seal produces a new AES-GCM nonce and therefore a new digest.
 */
async function materialGenerationDigest(blob: StoredSecretBlob): Promise<string> {
  const preimage = stableStringify({
    domain: `${NONCE_DOMAIN}#material-generation`,
    keyVersion: blob.keyVersion,
    ciphertext: blob.ciphertext,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage)),
  );
  return `sha256:${bytesToHex(digest)}`;
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

async function generateRuntimeInputValues(
  declaration: RuntimeInputDeclaration,
  authority: RuntimeInputAuthority,
  source: RuntimeInputValueSource | undefined,
): Promise<string> {
  const values: Record<string, string> = {};
  for (const entry of declaration.generatedSecrets) {
    if (source) {
      const value = await source({
        profileContract: declaration.contract,
        workspaceId: authority.workspaceId,
        capsuleId: authority.capsuleId,
        installConfigId: authority.installConfigId,
        binding: entry.binding,
        bytes: entry.bytes,
      });
      if (
        typeof value !== "string" ||
        value.length < RUNTIME_INPUT_MIN_VALUE_LENGTH ||
        value.includes(NUL) ||
        new TextEncoder().encode(value).byteLength >
          RUNTIME_INPUT_MAX_VALUE_BYTES
      ) {
        invalid("host runtime input derivation produced an unusable value");
      }
      values[entry.binding] = value;
      continue;
    }
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
    // Below the runner's redaction floor a value could not be stripped out of
    // command output, so it must never leave the control plane.
    if (value.length < RUNTIME_INPUT_MIN_VALUE_LENGTH) {
      invalid("sealed runtime input value is below the redaction floor");
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

/**
 * Owner fence. It proves the row belongs to this Capsule and this partition,
 * independently of which profile generation sealed it, so a drifted blob can
 * still be recognised (and re-sealed or retired) rather than aliasing another
 * Capsule's material.
 */
function assertRuntimeInputOwner(input: {
  readonly blob: StoredSecretBlob;
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly partition: SecretPartition;
}): void {
  if (
    input.blob.connectionId !== input.ownerRef ||
    input.blob.workspaceId !== input.workspaceId ||
    input.blob.kind !== input.partition ||
    input.blob.encryptedDek !== `${BLOB_SCHEME}/${input.partition}`
  ) {
    invalid("runtime input owner fence changed");
  }
}

function assertRuntimeInputBlob(input: {
  readonly blob: StoredSecretBlob;
  readonly ownerRef: string;
  readonly workspaceId: string;
  readonly partition: SecretPartition;
  readonly aad: string;
}): void {
  assertRuntimeInputOwner(input);
  if (input.blob.aad !== input.aad) {
    invalid("runtime input profile fence changed");
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
