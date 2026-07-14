/**
 * Dependencies domain service (Core Specification §14 / §15).
 *
 * A Dependency is a DAG edge within a Workspace connecting a producer
 * Capsule's outputs to a consumer Capsule's inputs. This service
 * owns Dependency creation / listing / deletion and enforces the structural
 * invariants of the dependency graph:
 *
 *   - structural endpoints by mode/visibility (spec §15 / §18):
 *       - `variable_injection` + `workspace`: same-Workspace edge (no OutputShare);
 *       - `remote_state` + `workspace`: same-Workspace edge; outputs mapping MAY be
 *         empty (a bare `terraform_remote_state` read), but a non-empty mapping
 *         is still validated;
 *       - `published_output` + `cross_workspace`: cross-Workspace edge backed by an
 *         ACTIVE OutputShare from the producer's Workspace to the consumer's Workspace
 *         covering EVERY mapped `from` name (the consumer maps from the SHARED
 *         name/alias the grant exposes);
 *       - every other mode/visibility combination is rejected (notably
 *         `cross_workspace` + `variable_injection`, which would cross a Workspace
 *         boundary without a grant);
 *   - no self-edge (a Capsule cannot depend on itself);
 *   - adding the edge must not create a cycle (checked via takosumi-graph
 *     `detectCycle` over the Workspace's existing edges + the candidate) for ALL
 *     modes;
 *   - the outputs mapping must be non-empty for `variable_injection` /
 *     `published_output` (an empty map pins nothing); `remote_state` relaxes
 *     this.
 *
 * The plan-time DependencySnapshot pinning + apply-time verification live in the
 * deploy-control controller (it has the Output + state-generation
 * context); this service is the edge CRUD + structural gate.
 */

import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import { detectCycle, type GraphEdge } from "takosumi-graph";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import {
  type CapsuleCoordination,
  withWorkspaceLease,
} from "../deploy-control/capsule_lease.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";

/**
 * Create-dependency request: the public {@link Dependency} minus the
 * service-assigned `id` / `createdAt`.
 */
export interface CreateDependencyRequest {
  readonly workspaceId: string;
  readonly producerCapsuleId: string;
  readonly consumerCapsuleId: string;
  readonly mode: DependencyMode;
  readonly outputs: Readonly<Record<string, DependencyOutputMapping>>;
  readonly visibility: DependencyVisibility;
}

/** The two directed views of a Capsule's edges (spec §14). */
export interface CapsuleDependencies {
  /** Edges where this Capsule is the PRODUCER (downstream consumers). */
  readonly asProducer: readonly Dependency[];
  /** Edges where this Capsule is the CONSUMER (upstream producers). */
  readonly asConsumer: readonly Dependency[];
}

export interface DependenciesServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  /** Workspace-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
  /**
   * Coordination seam used to serialize a Workspace's dependency-graph mutation
   * (the cycle check-then-write critical section) across isolates. When
   * injected, {@link DependenciesService.createDependency} takes the
   * `workspace-graph:{workspaceId}` lease around `list edges → detectCycle → put edge`
   * so two concurrent inverse-edge creates (A→B and B→A) cannot both pass the
   * acyclic check and wedge the DAG. When omitted, creation is single-isolate
   * safe (JS run-to-completion serializes the in-process critical section).
   */
  readonly coordination?: CapsuleCoordination;
}

export class DependenciesService {
  readonly #store: OpenTofuControlStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #activity: ActivityRecorder;
  readonly #coordination?: CapsuleCoordination;

  constructor(dependencies: DependenciesServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId =
      dependencies.newId ??
      ((prefix) =>
        `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#coordination = dependencies.coordination;
  }

  /**
   * Creates a Dependency edge after enforcing every structural invariant
   * (spec §14 / §15 / §18). The accepted mode/visibility combinations are:
   *
   *   - `variable_injection` + `workspace`: same-Workspace edge, non-empty mapping;
   *   - `remote_state` + `workspace`: same-Workspace edge, mapping MAY be empty (a bare
   *     `terraform_remote_state` read);
   *   - `published_output` + `cross_workspace`: cross-Workspace edge backed by an ACTIVE
   *     OutputShare from the producer's Workspace to the consumer's Workspace covering
   *     every mapped `from` name (the consumer maps from the SHARED name/alias).
   *
   * Every other combination is rejected. The edge must not create a cycle, and a
   * self-edge is rejected for all modes.
   */
  async createDependency(
    request: CreateDependencyRequest,
  ): Promise<Dependency> {
    const workspaceId = request.workspaceId;
    const producerCapsuleId = request.producerCapsuleId;
    const consumerCapsuleId = request.consumerCapsuleId;
    requireNonEmptyString(workspaceId, "workspaceId");
    requireNonEmptyString(producerCapsuleId, "producerCapsuleId");
    requireNonEmptyString(consumerCapsuleId, "consumerCapsuleId");
    // Mode/visibility gate (spec §15 / §18). Only three combinations are
    // executable: variable_injection+workspace, remote_state+workspace, and
    // published_output+cross_workspace. Everything else (notably
    // cross_workspace+variable_injection, which would cross a Workspace boundary without
    // a grant) is rejected.
    assertSupportedModeVisibility(request.mode, request.visibility);
    // No self-edge: a Capsule depending on itself is the smallest cycle
    // and never has a producer Output to consume. Applies to all modes.
    if (producerCapsuleId === consumerCapsuleId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "a dependency cannot connect a Capsule to itself (self-edge)",
      );
    }
    // The outputs mapping is the whole point of a variable_injection /
    // published_output edge: an empty map would pin nothing. remote_state relaxes
    // this — a bare `terraform_remote_state` read needs no name mapping — but a
    // non-empty remote_state mapping is still validated below.
    if (
      request.mode !== "remote_state" &&
      Object.keys(request.outputs).length === 0
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "dependency outputs mapping must declare at least one producer->consumer output",
      );
    }
    validateOutputMappings(request.outputs);

    const producer = await this.#store.getCapsule(producerCapsuleId);
    if (!producer) {
      throw new OpenTofuControllerError(
        "not_found",
        `producer capsule ${producerCapsuleId} not found`,
      );
    }
    const consumer = await this.#store.getCapsule(consumerCapsuleId);
    if (!consumer) {
      throw new OpenTofuControllerError(
        "not_found",
        `consumer capsule ${consumerCapsuleId} not found`,
      );
    }
    // The consumer always belongs to the request Workspace.
    if (consumer.workspaceId !== workspaceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "dependency consumer must belong to this workspace",
      );
    }
    if (request.visibility === "workspace") {
      // Same-Workspace invariant (variable_injection / remote_state).
      if (producer.workspaceId !== workspaceId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "dependency producer and consumer must both belong to this workspace",
        );
      }
    } else {
      // cross_workspace (published_output): the producer lives in another
      // Workspace and an ACTIVE OutputShare authorizes the edge.
      if (producer.workspaceId === consumer.workspaceId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "cross_workspace dependency producer and consumer are in the same workspace; use workspace visibility instead",
        );
      }
      await this.#assertActiveShareCovers(producer, consumer, request.outputs);
    }

    // Cycle prevention is a check-then-write: list the Workspace's existing edges,
    // ask `detectCycle` whether the candidate would close a cycle, and (if not)
    // persist the edge. Two concurrent creates of the inverse edges (A→B and
    // B→A) could each observe an acyclic graph and BOTH persist, wedging the DAG
    // with a cycle. Serialize this critical section per Workspace when a
    // coordination seam is injected; when
    // omitted, JS run-to-completion serializes it within a single isolate.
    const created = await this.#withWorkspaceGraphLease(workspaceId, () =>
      this.#commitEdge(request),
    );
    // Activity (§27 / §34): a Dependency edge was added. Edge ids + output
    // mapping names only — no values.
    await this.#activity.record({
      workspaceId: created.workspaceId,
      action: "dependency.created",
      targetType: "dependency",
      targetId: created.id,
      metadata: {
        producerCapsuleId: created.producerCapsuleId,
        consumerCapsuleId: created.consumerCapsuleId,
        mode: created.mode,
        outputNames: Object.keys(created.outputs),
      },
    });
    return created;
  }

  /**
   * Runs `work` under the Workspace's dependency-graph lease when coordination is
   * wired, else inline. Centralizes the serialization boundary so the
   * check-then-write in {@link DependenciesService.createDependency} cannot be
   * interleaved across isolates.
   */
  #withWorkspaceGraphLease<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    if (!this.#coordination) return work();
    return withWorkspaceLease(
      this.#coordination,
      { workspaceId, holderId: `dependencies:${this.#newId("hold")}` },
      work,
    );
  }

  /**
   * The serialized critical section: re-read the Workspace's edges, reject a
   * cycle-creating candidate with a typed `failed_precondition`, and persist the
   * new edge. Runs inside {@link DependenciesService.#withWorkspaceGraphLease}.
   */
  async #commitEdge(request: CreateDependencyRequest): Promise<Dependency> {
    const workspaceId = request.workspaceId;
    const producerCapsuleId = request.producerCapsuleId;
    const consumerCapsuleId = request.consumerCapsuleId;
    const existing =
      await this.#store.listDependenciesByWorkspace(workspaceId);
    const edges: readonly GraphEdge[] = existing.map((dep) => ({
      from: dep.producerCapsuleId,
      to: dep.consumerCapsuleId,
    }));
    const candidate: GraphEdge = {
      from: producerCapsuleId,
      to: consumerCapsuleId,
    };
    const cycle = detectCycle(edges, candidate);
    if (cycle !== undefined) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_cycle: adding ${candidate.from} -> ${candidate.to} would ` +
          `create a cycle (${cycle.join(" -> ")})`,
      );
    }

    const dependency: Dependency = {
      id: this.#newId("dep"),
      workspaceId,
      producerCapsuleId,
      consumerCapsuleId,
      mode: request.mode,
      outputs: request.outputs,
      visibility: request.visibility,
      createdAt: this.#now(),
    };
    return await this.#store.putDependency(dependency);
  }

  /**
   * Asserts a `published_output` cross-Workspace edge is authorized (spec §18):
   * an ACTIVE OutputShare from the producer Workspace to the consumer Workspace,
   * for the producer Capsule, covering EVERY mapped `from` name. The consumer maps
   * from the SHARED name the grant exposes (the share entry's `alias` when set,
   * else its `name`), so the covered set is the union of those shared names
   * across the consumer's active shares. A missing/revoked grant, or one that
   * does not cover a mapped name, is a typed `failed_precondition`.
   */
  async #assertActiveShareCovers(
    producer: { readonly id: string; readonly workspaceId: string },
    consumer: { readonly workspaceId: string },
    outputs: Readonly<Record<string, DependencyOutputMapping>>,
  ): Promise<void> {
    const shares = await this.#store.listOutputSharesToWorkspace(
      consumer.workspaceId,
    );
    // Only ACTIVE shares from this producer in this producer Workspace count.
    const covered = new Set<string>();
    for (const share of shares) {
      if (
        share.status !== "active" ||
        share.fromWorkspaceId !== producer.workspaceId ||
        share.producerCapsuleId !== producer.id
      )
        continue;
      for (const entry of share.outputs) {
        // The consumer references the SHARED name the grant exposes: the alias
        // when set, otherwise the producer output name. Sensitive entries are
        // allowed here as grants; the deploy controller later requires a
        // sensitive output resolver before it can inject a value.
        covered.add(entry.alias ?? entry.name);
      }
    }
    const requested = Object.values(outputs).map((mapping) => mapping.from);
    const missing = requested.filter((name) => !covered.has(name));
    if (missing.length > 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "output_share_required: no active OutputShare covers the requested outputs",
      );
    }
  }

  /**
   * Lists the Dependencies touching a Capsule, split into the directed
   * views: edges where it is the PRODUCER (`asProducer`, its downstream
   * consumers) and edges where it is the CONSUMER (`asConsumer`, its upstream
   * producers). Spec §14.
   */
  async listForCapsule(capsuleId: string): Promise<CapsuleDependencies> {
    requireNonEmptyString(capsuleId, "capsuleId");
    const [asProducer, asConsumer] = await Promise.all([
      this.#store.listDependenciesForProducer(capsuleId),
      this.#store.listDependenciesForConsumer(capsuleId),
    ]);
    return { asProducer, asConsumer };
  }

  /** Deletes a Dependency edge. Returns whether a row was removed. */
  async deleteDependency(id: string): Promise<boolean> {
    requireNonEmptyString(id, "dependencyId");
    // Read the edge first so the audit event can carry the Workspace + endpoints.
    const existing = await this.#store.getDependency(id);
    const removed = await this.#store.deleteDependency(id);
    if (removed && existing) {
      // Activity (§27 / §34): a Dependency edge was removed.
      await this.#activity.record({
        workspaceId: existing.workspaceId,
        action: "dependency.deleted",
        targetType: "dependency",
        targetId: existing.id,
        metadata: {
          producerCapsuleId: existing.producerCapsuleId,
          consumerCapsuleId: existing.consumerCapsuleId,
        },
      });
    }
    return removed;
  }

  /** Reads a Dependency edge by id (used by routes for Workspace permission gating). */
  async getDependency(id: string): Promise<Dependency | undefined> {
    requireNonEmptyString(id, "dependencyId");
    return await this.#store.getDependency(id);
  }

  /**
   * Lists every Dependency edge within a Workspace. Backs the Workspace
   * dependency-graph projection.
   */
  async listByWorkspace(workspaceId: string): Promise<readonly Dependency[]> {
    requireNonEmptyString(workspaceId, "workspaceId");
    return await this.#store.listDependenciesByWorkspace(workspaceId);
  }

}

/**
 * Gates the (mode, visibility) pair (spec §15 / §18). Only three combinations
 * have an execution path:
 *   - `variable_injection` + `workspace`
 *   - `remote_state` + `workspace`
 *   - `published_output` + `cross_workspace`
 * Every other pair is rejected. `cross_workspace` with a non-published-output
 * mode would cross a Workspace boundary without an OutputShare; a `workspace`
 * `published_output` is meaningless (same-Workspace output
 * flow is `variable_injection`).
 */
function assertSupportedModeVisibility(
  mode: DependencyMode,
  visibility: DependencyVisibility,
): void {
  const ok =
    (mode === "variable_injection" && visibility === "workspace") ||
    (mode === "remote_state" && visibility === "workspace") ||
    (mode === "published_output" && visibility === "cross_workspace");
  if (ok) return;
  if (mode === "published_output" && visibility === "workspace") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "published_output requires cross_workspace visibility (same-Workspace output " +
        "flow uses variable_injection)",
    );
  }
  if (visibility === "cross_workspace") {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `dependency mode ${mode} cannot cross a Workspace boundary; cross_workspace ` +
        "requires published_output (backed by an OutputShare)",
    );
  }
  throw new OpenTofuControllerError(
    "invalid_argument",
    `unsupported dependency mode/visibility combination: ${mode}/${visibility}`,
  );
}

/**
 * Validates each output mapping entry: `from` (producer output name) and `to`
 * (consumer input name) must be non-empty strings, and `required` a boolean.
 * The map KEY is the logical mapping name; spec examples key by the consumer
 * input name, but the canonical pin uses the entry's `to` field.
 */
function validateOutputMappings(
  outputs: Readonly<Record<string, DependencyOutputMapping>>,
): void {
  for (const [key, mapping] of Object.entries(outputs)) {
    requireNonEmptyString(key, "outputs key");
    requireNonEmptyString(mapping.from, `outputs.${key}.from`);
    requireNonEmptyString(mapping.to, `outputs.${key}.to`);
    if (typeof mapping.required !== "boolean") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `outputs.${key}.required must be a boolean`,
      );
    }
  }
}
