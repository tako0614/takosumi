/**
 * Provider-neutral service-side runtime materialization.
 *
 * The declaration is stored only on Takosumi's DB-owned InstallConfig. It is
 * not repository metadata, an OpenTofu Output convention, or provider
 * configuration. The control plane forwards this declaration to the selected
 * Resource adapter together with the exact Capsule owner and canonical
 * Resource connection graph.
 *
 * Every value crossing this seam is an opaque host reference. Secret bytes,
 * OAuth credentials, provider ids, account ids, and native bindings stay
 * inside the selected host.
 */

export const HOST_RUNTIME_MATERIALIZATION_CONTRACT =
  "takosumi.host-runtime-materialization/v1" as const;

export type HostRuntimeOpaqueSecretRef = `secret:${string}`;
export type HostRuntimeOpaqueCapabilityRef = `capability:${string}`;

export interface HostRuntimeGeneratedSecretRequirement {
  readonly kind: "generated_secret";
  /** Stable application binding/env name. */
  readonly binding: string;
  /** Logical ref selected by DB-owned service configuration. */
  readonly secretRef: HostRuntimeOpaqueSecretRef;
  readonly bytes: number;
  readonly encoding: "hex" | "base64url";
}

export interface HostRuntimePublicOidcRequirement {
  readonly kind: "public_oidc";
  readonly id: string;
  readonly callbackPath: string;
  readonly scopes: readonly string[];
  /**
   * Each field is delivered through a sealed host reference. Public-looking
   * OIDC values are still runtime authority and are not copied into Resource
   * outputs or an adapter's plain configuration map.
   */
  readonly bindings: {
    readonly issuerUrl: {
      readonly binding: string;
      readonly capabilityRef: HostRuntimeOpaqueCapabilityRef;
    };
    readonly clientId: {
      readonly binding: string;
      readonly capabilityRef: HostRuntimeOpaqueCapabilityRef;
    };
    readonly ownerSubject: {
      readonly binding: string;
      readonly capabilityRef: HostRuntimeOpaqueCapabilityRef;
    };
    readonly redirectUri: {
      readonly binding: string;
      readonly capabilityRef: HostRuntimeOpaqueCapabilityRef;
    };
  };
}

export interface HostRuntimeManagedConnectionRequirement {
  readonly kind: "managed_connection";
  readonly binding: string;
  /** Alias in the consumer Resource's canonical `spec.connections` graph. */
  readonly connectionAlias: string;
  readonly requiredPermission: string;
  readonly capabilityRef: HostRuntimeOpaqueCapabilityRef;
}

export type HostRuntimeMaterialRequirement =
  | HostRuntimeGeneratedSecretRequirement
  | HostRuntimePublicOidcRequirement
  | HostRuntimeManagedConnectionRequirement;

export interface HostRuntimeBackgroundActivationRequirement {
  readonly id: string;
  /**
   * Queue sources are outgoing connections declared by the consumer runtime.
   * Schedule sources are incoming edges: the alias is declared on the Schedule
   * connection which targets the consumer HttpService. Keeping the direction
   * explicit prevents a host from inventing a circular HttpService -> Schedule
   * connection merely to materialize a cron trigger.
   */
  readonly sourceResourceKind: "Queue" | "Schedule";
  readonly sourceConnectionAlias: string;
  readonly deadLetterConnectionAlias?: string;
  /** App-defined opaque handler token. The host never interprets it. */
  readonly entrypoint: string;
  readonly retry: {
    readonly maxAttempts: number;
    readonly retryDelaySeconds: number;
    readonly onExhausted: "dead_letter" | "fail";
  };
}

export interface InstallConfigHostRuntimeMaterialization {
  readonly contract: typeof HOST_RUNTIME_MATERIALIZATION_CONTRACT;
  readonly requirements: readonly HostRuntimeMaterialRequirement[];
  readonly backgroundActivations?: readonly HostRuntimeBackgroundActivationRequirement[];
}

/**
 * Exact request attached to Resource adapter operations by Takosumi Core.
 *
 * The Resource adapter still receives the canonical Resource id, generation,
 * revision, and resolved connections on its ordinary input. This envelope
 * proves which DB-owned InstallConfig and Capsule owner selected the
 * requirements, without transporting any resolved value.
 */
export interface HostRuntimeMaterializationRequest {
  readonly contract: typeof HOST_RUNTIME_MATERIALIZATION_CONTRACT;
  readonly installConfigId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly installingPrincipalId: string;
  readonly requirements: readonly HostRuntimeMaterialRequirement[];
  readonly backgroundActivations?: readonly HostRuntimeBackgroundActivationRequirement[];
}

export function parseInstallConfigHostRuntimeMaterialization(
  value: unknown,
): InstallConfigHostRuntimeMaterialization {
  const document = exactRecord(value, [
    "contract",
    "requirements",
    "backgroundActivations",
  ]);
  if (document.contract !== HOST_RUNTIME_MATERIALIZATION_CONTRACT) {
    throw new TypeError("host runtime materialization contract is invalid");
  }
  if (
    !Array.isArray(document.requirements) ||
    document.requirements.length > 64
  ) {
    throw new TypeError("host runtime requirements are invalid");
  }
  const ids = new Set<string>();
  const bindings = new Set<string>();
  const refs = new Set<string>();
  const requirements = document.requirements.map((requirement, index) => {
    const row = record(requirement);
    if (row.kind === "generated_secret") {
      const parsed = exactRecord(row, [
        "kind",
        "binding",
        "secretRef",
        "bytes",
        "encoding",
      ]);
      const binding = runtimeBinding(parsed.binding);
      const secretRef = opaqueRef(parsed.secretRef, "secret:");
      unique(bindings, binding, "host runtime binding");
      unique(refs, secretRef, "host runtime ref");
      if (
        !Number.isSafeInteger(parsed.bytes) ||
        (parsed.bytes as number) < 16 ||
        (parsed.bytes as number) > 1_024 ||
        (parsed.encoding !== "hex" && parsed.encoding !== "base64url")
      ) {
        throw new TypeError(`host runtime requirement ${index} is invalid`);
      }
      return {
        kind: "generated_secret",
        binding,
        secretRef: secretRef as HostRuntimeOpaqueSecretRef,
        bytes: parsed.bytes as number,
        encoding: parsed.encoding,
      } satisfies HostRuntimeGeneratedSecretRequirement;
    }
    if (row.kind === "public_oidc") {
      const parsed = exactRecord(row, [
        "kind",
        "id",
        "callbackPath",
        "scopes",
        "bindings",
      ]);
      const id = token(parsed.id);
      unique(ids, id, "host runtime requirement id");
      const callbackPath = exactCallbackPath(parsed.callbackPath);
      const scopes = stringSet(parsed.scopes, 32, "OIDC scopes");
      if (!scopes.includes("openid")) {
        throw new TypeError("host runtime OIDC scopes must include openid");
      }
      const oidcBindings = exactRecord(parsed.bindings, [
        "issuerUrl",
        "clientId",
        "ownerSubject",
        "redirectUri",
      ]);
      const field = (
        name: "issuerUrl" | "clientId" | "ownerSubject" | "redirectUri",
      ): {
        readonly binding: string;
        readonly capabilityRef: HostRuntimeOpaqueCapabilityRef;
      } => {
        const value = exactRecord(oidcBindings[name], [
          "binding",
          "capabilityRef",
        ]);
        const binding = runtimeBinding(value.binding);
        const capabilityRef = opaqueRef(value.capabilityRef, "capability:");
        unique(bindings, binding, "host runtime binding");
        unique(refs, capabilityRef, "host runtime ref");
        return {
          binding,
          capabilityRef: capabilityRef as HostRuntimeOpaqueCapabilityRef,
        };
      };
      return {
        kind: "public_oidc",
        id,
        callbackPath,
        scopes,
        bindings: {
          issuerUrl: field("issuerUrl"),
          clientId: field("clientId"),
          ownerSubject: field("ownerSubject"),
          redirectUri: field("redirectUri"),
        },
      } satisfies HostRuntimePublicOidcRequirement;
    }
    if (row.kind === "managed_connection") {
      const parsed = exactRecord(row, [
        "kind",
        "binding",
        "connectionAlias",
        "requiredPermission",
        "capabilityRef",
      ]);
      const binding = runtimeBinding(parsed.binding);
      const capabilityRef = opaqueRef(parsed.capabilityRef, "capability:");
      unique(bindings, binding, "host runtime binding");
      unique(refs, capabilityRef, "host runtime ref");
      return {
        kind: "managed_connection",
        binding,
        connectionAlias: alias(parsed.connectionAlias),
        requiredPermission: permission(parsed.requiredPermission),
        capabilityRef: capabilityRef as HostRuntimeOpaqueCapabilityRef,
      } satisfies HostRuntimeManagedConnectionRequirement;
    }
    throw new TypeError(`host runtime requirement ${index} kind is invalid`);
  });
  const backgroundActivations =
    document.backgroundActivations === undefined
      ? undefined
      : backgroundRequirements(document.backgroundActivations);
  return {
    contract: HOST_RUNTIME_MATERIALIZATION_CONTRACT,
    requirements,
    ...(backgroundActivations ? { backgroundActivations } : {}),
  };
}

function backgroundRequirements(
  value: unknown,
): readonly HostRuntimeBackgroundActivationRequirement[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError("host runtime background activations are invalid");
  }
  const ids = new Set<string>();
  return value.map((entry) => {
    const row = exactRecord(entry, [
      "id",
      "sourceResourceKind",
      "sourceConnectionAlias",
      "deadLetterConnectionAlias",
      "entrypoint",
      "retry",
    ]);
    const id = token(row.id);
    unique(ids, id, "background activation id");
    if (row.sourceResourceKind !== "Queue" && row.sourceResourceKind !== "Schedule") {
      throw new TypeError("background activation source kind is invalid");
    }
    const sourceConnectionAlias = alias(row.sourceConnectionAlias);
    const deadLetterConnectionAlias =
      row.deadLetterConnectionAlias === undefined
        ? undefined
        : alias(row.deadLetterConnectionAlias);
    if (deadLetterConnectionAlias === sourceConnectionAlias) {
      throw new TypeError(
        "background source connection cannot be its own dead letter queue",
      );
    }
    if (
      row.sourceResourceKind === "Schedule" &&
      deadLetterConnectionAlias !== undefined
    ) {
      throw new TypeError(
        "Schedule background activation cannot declare a dead letter queue",
      );
    }
    const retry = exactRecord(row.retry, [
      "maxAttempts",
      "retryDelaySeconds",
      "onExhausted",
    ]);
    if (
      !Number.isSafeInteger(retry.maxAttempts) ||
      (retry.maxAttempts as number) < 1 ||
      (retry.maxAttempts as number) > 100 ||
      !Number.isSafeInteger(retry.retryDelaySeconds) ||
      (retry.retryDelaySeconds as number) < 0 ||
      (retry.retryDelaySeconds as number) > 86_400 ||
      (retry.onExhausted !== "dead_letter" && retry.onExhausted !== "fail") ||
      (row.sourceResourceKind === "Schedule" && retry.onExhausted !== "fail") ||
      (retry.onExhausted === "dead_letter" &&
        deadLetterConnectionAlias === undefined)
    ) {
      throw new TypeError("background activation retry policy is invalid");
    }
    return {
      id,
      sourceResourceKind: row.sourceResourceKind,
      sourceConnectionAlias,
      ...(deadLetterConnectionAlias ? { deadLetterConnectionAlias } : {}),
      entrypoint: token(row.entrypoint),
      retry: {
        maxAttempts: retry.maxAttempts as number,
        retryDelaySeconds: retry.retryDelaySeconds as number,
        onExhausted: retry.onExhausted,
      },
    };
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const row = record(value);
  const allowed = new Set(keys);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new TypeError("host runtime materialization has unknown fields");
  }
  return row;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("host runtime materialization record is invalid");
  }
  return value as Record<string, unknown>;
}

function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new TypeError("host runtime token is invalid");
  }
  return value;
}

function alias(value: unknown): string {
  const parsed = token(value);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(parsed)) {
    throw new TypeError("host runtime connection alias is invalid");
  }
  return parsed;
}

function runtimeBinding(value: unknown): string {
  const parsed = token(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(parsed)) {
    throw new TypeError("host runtime binding is invalid");
  }
  return parsed;
}

function permission(value: unknown): string {
  const parsed = token(value);
  if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(parsed)) {
    throw new TypeError("host runtime permission is invalid");
  }
  return parsed;
}

function opaqueRef(value: unknown, prefix: string): string {
  const parsed = token(value);
  if (
    !parsed.startsWith(prefix) ||
    parsed.length <= prefix.length ||
    /(?:bearer|token=|password=|secret=)/iu.test(parsed)
  ) {
    throw new TypeError("host runtime opaque ref is invalid");
  }
  return parsed;
}

function exactCallbackPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "..") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("host runtime OIDC callback path is invalid");
  }
  return value;
}

function stringSet(
  value: unknown,
  limit: number,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limit) {
    throw new TypeError(`${label} are invalid`);
  }
  const items = value.map(token);
  if (
    new Set(items).size !== items.length ||
    [...items].sort().some((item, index) => item !== items[index])
  ) {
    throw new TypeError(`${label} must be unique and sorted`);
  }
  return items;
}

function unique(set: Set<string>, value: string, label: string): void {
  if (set.has(value)) throw new TypeError(`${label} must be unique`);
  set.add(value);
}
