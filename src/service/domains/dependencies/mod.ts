/**
 * Dependencies domain service (Core Specification §14 / §15).
 *
 * A Dependency is a DAG edge within a Space connecting a producer
 * Installation's outputs to a consumer Installation's inputs. This service
 * owns Dependency creation / listing / deletion and enforces the structural
 * invariants of the dependency graph:
 *
 *   - producer and consumer must exist and share the SAME Space (no cross-Space
 *     edge without an OutputShare — post-MVP, rejected here);
 *   - no self-edge (an Installation cannot depend on itself);
 *   - adding the edge must not create a cycle (checked via takosumi-graph
 *     `detectCycle` over the Space's existing edges + the candidate);
 *   - MVP supports `variable_injection` only (`remote_state` /
 *     `published_output` are rejected `not_implemented`);
 *   - `cross_space` visibility is rejected (requires an OutputShare, post-MVP);
 *   - the outputs mapping must be non-empty.
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
import { OpenTofuControllerError, requireNonEmptyString } from "../deploy-control/errors.ts";
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
    this.#newId = dependencies.newId ??
      ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
  }

  /**
   * Creates a Dependency edge after enforcing every structural invariant
   * (spec §14 / §15). The producer + consumer must exist and share the request
   * Space; the edge must be `variable_injection` + `space` visibility for MVP;
   * the outputs mapping must be non-empty; and the edge must not create a cycle.
   */
  async createDependency(request: CreateDependencyRequest): Promise<Dependency> {
    requireNonEmptyString(request.spaceId, "spaceId");
    requireNonEmptyString(
      request.producerInstallationId,
      "producerInstallationId",
    );
    requireNonEmptyString(
      request.consumerInstallationId,
      "consumerInstallationId",
    );
    // MVP modes (spec §15): only variable_injection is implemented. The other
    // two modes have a place in the contract but no execution path yet.
    if (request.mode !== "variable_injection") {
      throw new OpenTofuControllerError(
        "not_implemented",
        `dependency mode ${request.mode} is not implemented (only ` +
          `variable_injection is supported for MVP)`,
      );
    }
    // cross_space visibility requires an OutputShare (spec §18, post-MVP).
    if (request.visibility !== "space") {
      throw new OpenTofuControllerError(
        "not_implemented",
        `dependency visibility ${request.visibility} requires an OutputShare ` +
          `(cross-Space sharing is post-MVP); only space visibility is supported`,
      );
    }
    // No self-edge: an Installation depending on itself is the smallest cycle
    // and never has a producer OutputSnapshot to consume.
    if (request.producerInstallationId === request.consumerInstallationId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "a dependency cannot connect an installation to itself (self-edge)",
      );
    }
    // The outputs mapping is the whole point of a variable_injection edge: an
    // empty map would pin nothing.
    if (Object.keys(request.outputs).length === 0) {
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
    // Same-Space invariant: both endpoints must belong to the request Space.
    // A cross-Space edge needs an OutputShare (post-MVP).
    if (
      producer.spaceId !== request.spaceId ||
      consumer.spaceId !== request.spaceId
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency producer (${producer.spaceId}) and consumer ` +
          `(${consumer.spaceId}) must both belong to space ${request.spaceId}`,
      );
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
