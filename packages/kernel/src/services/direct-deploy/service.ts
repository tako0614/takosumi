// Direct deploy service — Deployment-centric port.
//
// Direct deploy (image / source / bundle workload inputs without a
// repo-managed manifest) is implemented as a thin shell over
// `DeploymentService.resolveDeployment` + `applyDeployment`. It generates
// a synthetic `.takosumi/app.yml` manifest, marks it with a `takosumi.directDeploy`
// override so manifest-managed groups can refuse silent mutation, and feeds
// it through the canonical Deployment lifecycle.

import { compileManifestToAppSpec } from "../../domains/deploy/compiler.ts";
import type {
  AppSpec,
  DeploySourceRef,
  PublicComputeSpec,
  PublicDeployManifest,
  PublicOutputSpec,
  PublicResourceSpec,
  PublicRouteSpec,
} from "../../domains/deploy/types.ts";
import type { Deployment, GroupHead } from "takosumi-contract";

export type DirectWorkloadInputKind = "image" | "source" | "bundle";

export interface DirectWorkloadBaseInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly workloadName?: string;
  readonly workloadType?: string;
  readonly version?: string;
  readonly env?: Record<string, string>;
  readonly nativeEnv?: Record<string, string>;
  readonly workloadEnv?: Record<string, string>;
  readonly port?: number;
  readonly entrypoint?: string;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly resources?: Record<string, PublicResourceSpec>;
  readonly routes?:
    | Record<string, PublicRouteSpec>
    | readonly PublicRouteSpec[];
  readonly outputs?:
    | Record<string, PublicOutputSpec>
    | readonly PublicOutputSpec[];
  readonly overrides?: Record<string, unknown>;
  /**
   * Direct deploys are generated manifests. If an existing group is currently
   * owned by a non-generated manifest, callers must opt in before the service
   * will create/apply a direct deploy for that group.
   */
  readonly allowManifestManagedGroupMutation?: boolean;
}

export interface DirectImageWorkloadInput extends DirectWorkloadBaseInput {
  readonly kind: "image";
  readonly image: string;
}

export interface DirectSourceWorkloadInput extends DirectWorkloadBaseInput {
  readonly kind: "source";
  readonly repositoryUrl: string;
  readonly ref?: string;
  readonly commitSha?: string;
  readonly image?: string;
}

export interface DirectBundleWorkloadInput extends DirectWorkloadBaseInput {
  readonly kind: "bundle";
  readonly packageName: string;
  readonly packageVersion?: string;
  readonly uri?: string;
  readonly image?: string;
}

export type DirectWorkloadDeployInput =
  | DirectImageWorkloadInput
  | DirectSourceWorkloadInput
  | DirectBundleWorkloadInput;

export interface DirectWorkloadCompilation {
  readonly manifest: PublicDeployManifest;
  readonly appSpec: AppSpec;
  readonly source: DeploySourceRef;
}

export interface ResolveDirectWorkloadResult extends DirectWorkloadCompilation {
  readonly deployment: Deployment;
}

export interface ApplyDirectWorkloadResult extends DirectWorkloadCompilation {
  readonly deployment: Deployment;
  readonly groupHead: GroupHead;
}

/**
 * Subset of the deploy-domain `DeploymentService` used by direct deploy. Kept
 * as a structural interface so this service stays decoupled from the concrete
 * `DeploymentService` class while Phase 3 Agent A finalises it.
 */
export interface DirectDeployDeploymentClient {
  resolveDeployment(input: DirectDeployResolveInput): Promise<Deployment>;
  applyDeployment(deploymentId: string): Promise<ApplyDeploymentOutcome>;
  getDeployment(deploymentId: string): Promise<Deployment | undefined>;
  getGroupHead(
    spaceId: string,
    groupId: string,
  ): Promise<GroupHead | undefined>;
}

export interface DirectDeployResolveInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly manifest: PublicDeployManifest;
  readonly source: DeploySourceRef;
  readonly mode?: "resolve" | "apply";
  readonly createdBy?: string;
}

export interface ApplyDeploymentOutcome {
  readonly deployment: Deployment;
  readonly groupHead: GroupHead;
}

export interface DirectDeployServiceOptions {
  readonly deploymentService: DirectDeployDeploymentClient;
}

export class ManifestManagedGroupMutationBlockedError extends Error {
  readonly spaceId: string;
  readonly groupId: string;
  readonly deploymentId: string;

  constructor(input: {
    readonly spaceId: string;
    readonly groupId: string;
    readonly deploymentId: string;
  }) {
    super(
      `direct deploy would mutate manifest-managed group ${input.spaceId}/${input.groupId}; set allowManifestManagedGroupMutation to proceed`,
    );
    this.name = "ManifestManagedGroupMutationBlockedError";
    this.spaceId = input.spaceId;
    this.groupId = input.groupId;
    this.deploymentId = input.deploymentId;
  }
}

export class DirectDeployService {
  readonly #deployments: DirectDeployDeploymentClient;

  constructor(options: DirectDeployServiceOptions) {
    this.#deployments = options.deploymentService;
  }

  compile(input: DirectWorkloadDeployInput): DirectWorkloadCompilation {
    const manifest = buildDirectWorkloadManifest(input);
    const source = buildDirectWorkloadSource(input);
    const appSpec = compileManifestToAppSpec(manifest, { source });
    return Object.freeze({ manifest, appSpec, source });
  }

  /**
   * Resolves a direct deploy into a `resolved` Deployment without applying.
   * Equivalent to `takos deploy --resolve-only` for an inline workload input.
   */
  async resolve(
    input: DirectWorkloadDeployInput,
  ): Promise<ResolveDirectWorkloadResult> {
    await this.#assertDirectMutationAllowed(input);
    const compiled = this.compile(input);
    const deployment = await this.#deployments.resolveDeployment({
      spaceId: input.spaceId,
      groupId: input.groupId,
      manifest: compiled.manifest,
      source: compiled.source,
      mode: "resolve",
    });
    return Object.freeze({ ...compiled, deployment });
  }

  /**
   * Resolves and immediately applies a direct deploy. Equivalent to the
   * Heroku-style `takos deploy <manifest>` sugar.
   */
  async apply(
    input: DirectWorkloadDeployInput,
  ): Promise<ApplyDirectWorkloadResult> {
    await this.#assertDirectMutationAllowed(input);
    const compiled = this.compile(input);
    const resolved = await this.#deployments.resolveDeployment({
      spaceId: input.spaceId,
      groupId: input.groupId,
      manifest: compiled.manifest,
      source: compiled.source,
      mode: "apply",
    });
    const outcome = await this.#deployments.applyDeployment(resolved.id);
    return Object.freeze({
      ...compiled,
      deployment: outcome.deployment,
      groupHead: outcome.groupHead,
    });
  }

  async #assertDirectMutationAllowed(
    input: DirectWorkloadDeployInput,
  ): Promise<void> {
    if (input.allowManifestManagedGroupMutation) {
      return;
    }
    const head = await this.#deployments.getGroupHead(
      input.spaceId,
      input.groupId,
    );
    if (!head) {
      return;
    }
    const current = await this.#deployments.getDeployment(
      head.current_deployment_id,
    );
    if (!current) {
      return;
    }
    const manifestSnapshot = current.input.manifest_snapshot;
    if (
      manifestSnapshot && !isDirectDeployGeneratedManifestSnapshot(
        manifestSnapshot,
      )
    ) {
      throw new ManifestManagedGroupMutationBlockedError({
        spaceId: input.spaceId,
        groupId: input.groupId,
        deploymentId: current.id,
      });
    }
  }
}

export function buildDirectWorkloadManifest(
  input: DirectWorkloadDeployInput,
): PublicDeployManifest {
  const componentName = input.workloadName ?? "web";
  const compute: PublicComputeSpec = {
    type: input.workloadType ?? defaultWorkloadType(input.kind),
    image: imageForInput(input),
    port: portForInput(input),
    entrypoint: input.entrypoint,
    command: input.command ? [...input.command] : undefined,
    args: input.args ? [...input.args] : undefined,
    env: { ...(input.workloadEnv ?? {}) },
  };

  return {
    name: input.groupId,
    version: input.version,
    env: { ...(input.env ?? {}), ...(input.nativeEnv ?? {}) },
    compute: { [componentName]: stripUndefined(compute) as PublicComputeSpec },
    resources: input.resources ? structuredClone(input.resources) : undefined,
    routes: input.routes ? cloneManifestCollection(input.routes) : undefined,
    outputs: input.outputs ? cloneManifestCollection(input.outputs) : undefined,
    overrides: {
      ...(input.overrides ?? {}),
      "takosumi.directDeploy": {
        generated: true,
        inputKind: input.kind,
      },
    },
  };
}

export function buildDirectWorkloadSource(
  input: DirectWorkloadDeployInput,
): DeploySourceRef {
  switch (input.kind) {
    case "image":
      return { kind: "manifest", uri: `direct:image:${input.image}` };
    case "source":
      return {
        kind: "git_ref",
        repositoryUrl: input.repositoryUrl,
        ref: input.ref,
        commitSha: input.commitSha,
      };
    case "bundle":
      return {
        kind: "package",
        uri: input.uri,
        packageName: input.packageName,
        packageVersion: input.packageVersion,
      };
  }
}

export function isDirectDeployGeneratedManifest(
  manifest: PublicDeployManifest,
): boolean {
  const marker = manifest.overrides?.["takosumi.directDeploy"];
  return !!marker && typeof marker === "object" &&
    (marker as { generated?: unknown }).generated === true;
}

/**
 * Detects the `takosumi.directDeploy.generated: true` marker on the serialized
 * manifest snapshot stored in `Deployment.input.manifest_snapshot`. We accept
 * either a JSON-encoded string snapshot or a YAML one that contains the
 * marker text, since the snapshot encoding is not part of this contract.
 */
export function isDirectDeployGeneratedManifestSnapshot(
  snapshot: string,
): boolean {
  if (snapshot.length === 0) return false;
  // Try JSON first.
  try {
    const parsed = JSON.parse(snapshot) as {
      overrides?: Record<string, unknown>;
    };
    if (parsed && typeof parsed === "object") {
      const marker = parsed.overrides?.["takosumi.directDeploy"];
      if (
        marker && typeof marker === "object" &&
        (marker as { generated?: unknown }).generated === true
      ) {
        return true;
      }
      return false;
    }
  } catch {
    // not JSON — fall through to text-shape probe
  }
  // YAML / textual fallback: presence of both keys is sufficient. The strict
  // detector is the manifest-shape variant above; this is the snapshot-shape
  // form whose only job is to short-circuit the silent-mutation guard.
  return /takos\.directDeploy/.test(snapshot) &&
    /generated:\s*true/.test(snapshot);
}

function cloneManifestCollection<T>(
  value: Record<string, T> | readonly T[],
): Record<string, T> | T[] {
  if (Array.isArray(value)) {
    return value.map((item) => structuredClone(item));
  }
  return structuredClone(value as Record<string, T>);
}

function defaultWorkloadType(kind: DirectWorkloadInputKind): string {
  return kind === "image" ? "container" : kind;
}

function imageForInput(input: DirectWorkloadDeployInput): string | undefined {
  switch (input.kind) {
    case "image":
      return input.image;
    case "source":
    case "bundle":
      return input.image;
  }
}

function portForInput(input: DirectWorkloadDeployInput): number | undefined {
  if (input.port !== undefined) {
    return input.port;
  }
  return imageForInput(input) ? 8080 : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
