/**
 * Dependencies domain service (Core Specification §14 / §15).
 *
 * A Dependency is a DAG edge within a Space connecting a producer
 * Installation's outputs to a consumer Installation's inputs. This service
 * owns Dependency creation / listing / deletion and enforces the structural
 * invariants of the dependency graph:
 *
 *   - structural endpoints by mode/visibility (spec §15 / §18):
 *       - `variable_injection` + `space`: same-Space edge (no OutputShare);
 *       - `remote_state` + `space`: same-Space edge; outputs mapping MAY be
 *         empty (a bare `terraform_remote_state` read), but a non-empty mapping
 *         is still validated;
 *       - `published_output` + `cross_space`: cross-Space edge backed by an
 *         ACTIVE OutputShare from the producer's Space to the consumer's Space
 *         covering EVERY mapped `from` name (the consumer maps from the SHARED
 *         name/alias the grant exposes);
 *       - every other mode/visibility combination is rejected (notably
 *         `cross_space` + `variable_injection`, which would cross a Space
 *         boundary without a grant);
 *   - no self-edge (an Installation cannot depend on itself);
 *   - adding the edge must not create a cycle (checked via takosumi-graph
 *     `detectCycle` over the Space's existing edges + the candidate) for ALL
 *     modes;
 *   - the outputs mapping must be non-empty for `variable_injection` /
 *     `published_output` (an empty map pins nothing); `remote_state` relaxes
 *     this.
 *
 * The plan-time DependencySnapshot pinning + apply-time verification live in the
 * deploy-control controller (it has the OutputSnapshot + state-generation
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
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";

/**
 * Create-dependency request: the public {@link Dependency} minus the
 * service-assigned `id` / `createdAt`.
 */
export interface CreateDependencyRequest {
  readonly spaceId: string;
  readonly producerInstallationId: string;
  readonly consumerInstallationId: string;
  readonly mode: DependencyMode;
  readonly outputs: Readonly<Record<string, DependencyOutputMapping>>;
  readonly visibility: DependencyVisibility;
}

/** The two directed views of an Installation's edges (spec §14). */
export interface InstallationDependencies {
  /** Edges where this Installation is the PRODUCER (downstream consumers). */
  readonly asProducer: readonly Dependency[];
  /** Edges where this Installation is the CONSUMER (upstream producers). */
  readonly asConsumer: readonly Dependency[];
}

export interface DependenciesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  /** Space-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
}

export class DependenciesService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #activity: ActivityRecorder;

  constructor(dependencies: DependenciesServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId =
      dependencies.newId ??
      ((prefix) =>
        `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
  }

  /**
   * Creates a Dependency edge after enforcing every structural invariant
   * (spec §14 / §15 / §18). The accepted mode/visibility combinations are:
   *
   *   - `variable_injection` + `space`: same-Space edge, non-empty mapping;
   *   - `remote_state` + `space`: same-Space edge, mapping MAY be empty (a bare
   *     `terraform_remote_state` read);
   *   - `published_output` + `cross_space`: cross-Space edge backed by an ACTIVE
   *     OutputShare from the producer's Space to the consumer's Space covering
   *     every mapped `from` name (the consumer maps from the SHARED name/alias).
   *
   * Every other combination is rejected. The edge must not create a cycle, and a
   * self-edge is rejected for all modes.
   */
  async createDependency(
    request: CreateDependencyRequest,
  ): Promise<Dependency> {
    requireNonEmptyString(request.spaceId, "spaceId");
    requireNonEmptyString(
      request.producerInstallationId,
      "producerInstallationId",
    );
    requireNonEmptyString(
      request.consumerInstallationId,
      "consumerInstallationId",
    );
    // Mode/visibility gate (spec §15 / §18). Only three combinations are
    // executable: variable_injection+space, remote_state+space, and
    // published_output+cross_space. Everything else (notably
    // cross_space+variable_injection, which would cross a Space boundary without
    // a grant) is rejected.
    assertSupportedModeVisibility(request.mode, request.visibility);
    // No self-edge: an Installation depending on itself is the smallest cycle
    // and never has a producer OutputSnapshot to consume. Applies to all modes.
    if (request.producerInstallationId === request.consumerInstallationId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "a dependency cannot connect an installation to itself (self-edge)",
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

    const producer = await this.#store.getInstallation(
      request.producerInstallationId,
    );
    if (!producer) {
      throw new OpenTofuControllerError(
        "not_found",
        `producer installation ${request.producerInstallationId} not found`,
      );
    }
    const consumer = await this.#store.getInstallation(
      request.consumerInstallationId,
    );
    if (!consumer) {
      throw new OpenTofuControllerError(
        "not_found",
        `consumer installation ${request.consumerInstallationId} not found`,
      );
    }
    // The consumer always belongs to the request Space (a Dependency is the
    // consumer's edge; its spaceId is the consumer Space).
    if (consumer.spaceId !== request.spaceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency consumer (${consumer.spaceId}) must belong to space ` +
          `${request.spaceId}`,
      );
    }
    if (request.visibility === "space") {
      // Same-Space invariant (variable_injection / remote_state): the producer
      // must also belong to the request Space.
      if (producer.spaceId !== request.spaceId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency producer (${producer.spaceId}) and consumer ` +
            `(${consumer.spaceId}) must both belong to space ${request.spaceId}`,
        );
      }
    } else {
      // cross_space (published_output): the producer lives in ANOTHER Space and
      // the edge is authorized by an ACTIVE OutputShare from the producer's Space
      // to the consumer's Space covering every mapped `from` name.
      if (producer.spaceId === consumer.spaceId) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `cross_space dependency producer and consumer both belong to space ` +
            `${producer.spaceId}; use a space-visibility dependency instead`,
        );
      }
      await this.#assertActiveShareCovers(producer, consumer, request.outputs);
    }

    // Cycle prevention: would adding producer -> consumer create a cycle in the
    // Space's existing dependency graph? `detectCycle` answers with the
    // candidate edge appended.
    const existing = await this.#store.listDependenciesBySpace(request.spaceId);
    const edges: readonly GraphEdge[] = existing.map((dep) => ({
      from: dep.producerInstallationId,
      to: dep.consumerInstallationId,
    }));
    const candidate: GraphEdge = {
      from: request.producerInstallationId,
      to: request.consumerInstallationId,
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
      spaceId: request.spaceId,
      producerInstallationId: request.producerInstallationId,
      consumerInstallationId: request.consumerInstallationId,
      mode: request.mode,
      outputs: request.outputs,
      visibility: request.visibility,
      createdAt: this.#now(),
    };
    const created = await this.#store.putDependency(dependency);
    // Activity (§27 / §34): a Dependency edge was added. Edge ids + output
    // mapping names only — no values.
    await this.#activity.record({
      spaceId: created.spaceId,
      action: "dependency.created",
      targetType: "dependency",
      targetId: created.id,
      metadata: {
        producerInstallationId: created.producerInstallationId,
        consumerInstallationId: created.consumerInstallationId,
        mode: created.mode,
        outputNames: Object.keys(created.outputs),
      },
    });
    return created;
  }

  /**
   * Asserts a `published_output` cross-Space edge is authorized (spec §18): an
   * ACTIVE OutputShare from the producer's Space to the consumer's Space, for the
   * producer Installation, covering EVERY mapped `from` name. The consumer maps
   * from the SHARED name the grant exposes (the share entry's `alias` when set,
   * else its `name`), so the covered set is the union of those shared names
   * across the consumer's active shares. A missing/revoked grant, or one that
   * does not cover a mapped name, is a typed `failed_precondition`.
   */
  async #assertActiveShareCovers(
    producer: { readonly id: string; readonly spaceId: string },
    consumer: { readonly spaceId: string },
    outputs: Readonly<Record<string, DependencyOutputMapping>>,
  ): Promise<void> {
    const shares = await this.#store.listOutputSharesToSpace(consumer.spaceId);
    // Only ACTIVE shares from THIS producer in THIS producer Space count.
    const covered = new Set<string>();
    for (const share of shares) {
      if (
        share.status !== "active" ||
        share.fromSpaceId !== producer.spaceId ||
        share.producerInstallationId !== producer.id
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
        `output_share_required: no active OutputShare from space ` +
          `${producer.spaceId} to space ${consumer.spaceId} covers ` +
          `${missing.join(", ")} for producer installation ${producer.id}`,
      );
    }
  }

  /**
   * Lists the Dependencies touching an Installation, split into the directed
   * views: edges where it is the PRODUCER (`asProducer`, its downstream
   * consumers) and edges where it is the CONSUMER (`asConsumer`, its upstream
   * producers). Spec §14.
   */
  async listForInstallation(
    installationId: string,
  ): Promise<InstallationDependencies> {
    requireNonEmptyString(installationId, "installationId");
    const [asProducer, asConsumer] = await Promise.all([
      this.#store.listDependenciesForProducer(installationId),
      this.#store.listDependenciesForConsumer(installationId),
    ]);
    return { asProducer, asConsumer };
  }

  /** Deletes a Dependency edge. Returns whether a row was removed. */
  async deleteDependency(id: string): Promise<boolean> {
    requireNonEmptyString(id, "dependencyId");
    // Read the edge first so the audit event can carry the Space + endpoints.
    const existing = await this.#store.getDependency(id);
    const removed = await this.#store.deleteDependency(id);
    if (removed && existing) {
      // Activity (§27 / §34): a Dependency edge was removed.
      await this.#activity.record({
        spaceId: existing.spaceId,
        action: "dependency.deleted",
        targetType: "dependency",
        targetId: existing.id,
        metadata: {
          producerInstallationId: existing.producerInstallationId,
          consumerInstallationId: existing.consumerInstallationId,
        },
      });
    }
    return removed;
  }

  /** Reads a Dependency edge by id (used by routes for space-permission gating). */
  async getDependency(id: string): Promise<Dependency | undefined> {
    requireNonEmptyString(id, "dependencyId");
    return await this.#store.getDependency(id);
  }

  /**
   * Lists every Dependency edge within a Space. Backs the Space dependency-graph
   * projection (spec §14): the account-plane `/api/v1/spaces/:id/graph`
   * route pairs these edges with the Space's Installations to render the DAG.
   */
  async listBySpace(spaceId: string): Promise<readonly Dependency[]> {
    requireNonEmptyString(spaceId, "spaceId");
    return await this.#store.listDependenciesBySpace(spaceId);
  }
}

/**
 * Gates the (mode, visibility) pair (spec §15 / §18). Only three combinations
 * have an execution path:
 *   - `variable_injection` + `space`
 *   - `remote_state` + `space`
 *   - `published_output` + `cross_space`
 * Every other pair is rejected. `cross_space` with a non-published_output mode
 * (e.g. `variable_injection`) would cross a Space boundary without an
 * OutputShare; a `space` `published_output` is meaningless (same-Space output
 * flow is `variable_injection`).
 */
function assertSupportedModeVisibility(
  mode: DependencyMode,
  visibility: DependencyVisibility,
): void {
  const ok =
    (mode === "variable_injection" && visibility === "space") ||
    (mode === "remote_state" && visibility === "space") ||
    (mode === "published_output" && visibility === "cross_space");
  if (ok) return;
  if (mode === "published_output" && visibility === "space") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "published_output requires cross_space visibility (same-Space output " +
        "flow uses variable_injection)",
    );
  }
  if (visibility === "cross_space") {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `dependency mode ${mode} cannot cross a Space boundary; cross_space ` +
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
