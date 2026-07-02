/**
 * Plan-time dependency + output-share resolution (spec §15 / §17 / §18).
 *
 * A cohesive collaborator pulled out of `OpenTofuDeploymentController`: it owns
 * the plan-time resolution of a consumer Capsule's Dependencies into the
 * injected variable values + pinned `DependencySnapshot` entries
 * ({@link DependencyResolutionService.resolveConsumerDependencies}), the ACTIVE
 * OutputShare coverage lookup for a `published_output` edge
 * ({@link DependencyResolutionService.resolveShareCoverage}), and the per-output
 * value resolution that pulls a producer output (cleartext via the
 * Output projection, or sensitive via the
 * {@link SensitiveOutputResolver}) into the consumer inputs.
 *
 * Behavior is identical to the prior inline controller methods: the seam moves
 * the resolution helpers but preserves exact signatures, error codes
 * (`failed_precondition` with the same `dependency_outputs_unavailable` /
 * `output_share_revoked` / `dependency_state_unavailable` /
 * `dependency_value_sealer_unavailable` / `sensitive_output_resolver_unavailable`
 * messages), and ordering. The DependencySnapshot pin / injection-into-request /
 * remote_state DISPATCH wiring stay on the controller (they are coupled to the
 * run-creation + dispatch path); `resolveShareCoverage` is re-exposed so the
 * controller's apply-time `#reverifyPublishedOutputShare` keeps using the same
 * coverage logic.
 *
 * Dependencies it needs are threaded in as ports: the {@link
 * OpenTofuDeploymentStore} for reads, plus the optional
 * {@link DependencyValueSealer} (seals a resolved sensitive value OUT of the
 * cleartext snapshot) and {@link SensitiveOutputResolver} (resolves a sensitive
 * producer output from the raw output artifact). When either is absent and an
 * edge resolves a sensitive value, the resolution fails closed exactly as
 * before.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  Installation,
  StateSnapshot,
} from "@takosumi/internal/deploy-control-api";
import type { Output as OutputSnapshot } from "takosumi-contract/outputs";
import type {
  DependencySnapshotEntry,
  DependencySnapshotMode,
  SealedDependencyValues,
} from "takosumi-contract/dependencies";
import type {
  SensitiveOutputResolver,
  SensitiveOutputValue,
} from "../output-shares/mod.ts";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { OpenTofuControllerError } from "./errors.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";

/**
 * At-rest sealer for the SENSITIVE pinned values of a DependencySnapshot entry
 * (spec §11 / §18). Mirrors the controller-side port: `seal` takes the
 * `{ name: value }` map of an edge's sensitive values and returns the sealed
 * blob persisted onto {@link SealedDependencyValues}. When absent, an edge that
 * resolves a sensitive value fails closed (`dependency_value_sealer_unavailable`)
 * rather than persisting cleartext.
 */
export interface DependencyValueSealerPort {
  seal(
    values: Readonly<Record<string, JsonValue>>,
  ): Promise<SealedDependencyValues>;
}

/**
 * Resolution result for a consumer Installation's Dependencies (spec §17):
 *   - `injectedValues` are merged into the plan request's inputs/variables;
 *   - `hasSensitiveInjected` is `true` when at least one injected value came
 *     from a SENSITIVE producer output (the runs_inputs sidecar must then seal);
 *   - `entries` are the DependencySnapshotEntry pins (one per edge) minus the
 *     run-level fields;
 *   - `mode` is `strict` for a production consumer, else `pinned` (§17).
 */
export interface ResolvedDependencies {
  readonly injectedValues: Readonly<Record<string, JsonValue>>;
  readonly hasSensitiveInjected: boolean;
  readonly entries: readonly DependencySnapshotEntry[];
  readonly mode: DependencySnapshotMode;
}

/**
 * The names a `published_output` cross-Space edge may consume, resolved from the
 * consumer Space's ACTIVE OutputShares for one producer Installation. Maps the
 * SHARED name (the grant alias, else the producer output name) -> the producer's
 * actual output name plus whether it must be resolved from the raw sensitive
 * output artifact instead of OutputSnapshot.spaceOutputs.
 */
export type ShareCoverage = ReadonlyMap<
  string,
  { readonly outputName: string; readonly sensitive: boolean }
>;

/**
 * Ports the controller injects into {@link DependencyResolutionService}. `store`
 * mirrors the controller's own handle so reads stay consistent; the optional
 * sealer / sensitive-output resolver match the controller's wiring so an edge
 * that resolves a sensitive value seals / resolves identically.
 */
export interface DependencyResolutionServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly dependencyValueSealer?: DependencyValueSealerPort;
  readonly sensitiveOutputResolver?: SensitiveOutputResolver;
}

/**
 * Collaborator owning plan-time dependency + output-share resolution. Behavior
 * is identical to the prior inline controller methods.
 */
export class DependencyResolutionService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;
  readonly #dependencyValueSealer?: DependencyValueSealerPort;

  constructor(dependencies: DependencyResolutionServiceDependencies) {
    this.#store = dependencies.store;
    this.#sensitiveOutputResolver = dependencies.sensitiveOutputResolver;
    this.#dependencyValueSealer = dependencies.dependencyValueSealer;
  }

  /**
   * Resolves a consumer Installation's Dependencies into the injected values +
   * pinned snapshot entries (spec §15 / §17). For each `variable_injection` edge
   * it reads the producer's current OutputSnapshot and pulls each mapped output
   * (`from`) into the injected values under the consumer input name (`to`). A
   * required mapping whose producer output is absent (no current OutputSnapshot,
   * or the named output is missing) is a typed `failed_precondition`
   * (`dependency_outputs_unavailable`). Returns `undefined` when the consumer has
   * no Dependencies. The snapshot `mode` is `strict` for a production environment,
   * else `pinned` (§17).
   */
  async resolveConsumerDependencies(
    consumer: Installation,
  ): Promise<ResolvedDependencies | undefined> {
    const dependencies = await this.#store.listDependenciesForConsumer(
      consumer.id,
    );
    if (dependencies.length === 0) return undefined;
    const injectedValues: Record<string, JsonValue> = {};
    let hasSensitiveInjected = false;
    const entries: DependencySnapshotEntry[] = [];
    for (const dependency of dependencies) {
      const producer = await this.#store.getInstallation(
        dependency.producerInstallationId,
      );
      if (!producer) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `dependency_outputs_unavailable: dependency ${dependency.id} producer ` +
            `installation ${dependency.producerInstallationId} not found`,
        );
      }
      // remote_state injects NO values: instead the producer StateSnapshot bytes
      // are pinned here and later materialized into the container at dispatch
      // time. This makes both `strict` and `pinned` plans apply the same producer
      // state bytes that were reviewed at plan time; strict mode additionally
      // rejects a producer whose current generation moved.
      if (dependency.mode === "remote_state") {
        const stateSnapshot =
          await this.#latestProducerStateSnapshotForDependency(
            dependency.id,
            producer,
          );
        const values: Record<string, JsonValue> = {};
        entries.push({
          dependencyId: dependency.id,
          producerCapsuleId: producer.id,
          producerInstallationId: producer.id,
          producerStateGeneration: stateSnapshot.generation,
          producerStateVersionId: stateSnapshot.id,
          producerStateSnapshotId: stateSnapshot.id,
          producerStateObjectKey: stateSnapshot.objectKey,
          producerStateDigest: stateSnapshot.digest,
          producerOutputId: "",
          producerOutputDigest: "",
          valuesDigest: await stableJsonDigest(values),
          values,
        });
        continue;
      }
      // variable_injection (same-Space) and published_output (cross-Space via an
      // active OutputShare) both pull producer outputs into the consumer inputs.
      // published_output restricts the readable names to the active grant and
      // resolves each mapped SHARED name back to the producer output name.
      const coverage =
        dependency.mode === "published_output"
          ? await this.resolveShareCoverage(producer, consumer)
          : undefined;
      const outputSnapshot = producer.currentOutputSnapshotId
        ? await this.#store.getOutputSnapshot(producer.currentOutputSnapshotId)
        : undefined;
      // Full plaintext value map for this edge (drives the digest). Sensitive
      // keys are tracked separately so they can be sealed out of `values`
      // before the snapshot is persisted (the digest stays over the FULL map).
      const values: Record<string, JsonValue> = {};
      const sensitiveValues: Record<string, JsonValue> = {};
      for (const mapping of Object.values(dependency.outputs)) {
        // For published_output the mapping `from` is the SHARED name the grant
        // exposes; resolve it to the producer output name (and fail
        // output_share_revoked when the active grant no longer covers it). For
        // variable_injection `from` IS the producer output name.
        let producerOutputName = mapping.from;
        let sensitive = false;
        if (coverage) {
          const resolved = coverage.get(mapping.from);
          if (resolved === undefined) {
            throw new OpenTofuControllerError(
              "failed_precondition",
              `output_share_revoked: dependency ${dependency.id} consumes ` +
                `shared output ${mapping.from} from producer installation ` +
                `${producer.id} but no active OutputShare covers it`,
            );
          }
          producerOutputName = resolved.outputName;
          sensitive = resolved.sensitive;
        }
        const resolvedValue = await this.#resolveDependencyOutputValue({
          dependencyId: dependency.id,
          producer,
          consumer,
          outputSnapshot,
          producerOutputName,
          sensitive,
        });
        if (!resolvedValue) {
          if (mapping.required) {
            throw new OpenTofuControllerError(
              "failed_precondition",
              `dependency_outputs_unavailable: dependency ${dependency.id} ` +
                `requires producer output ${producerOutputName} which the ` +
                `producer installation ${producer.id} has not published`,
            );
          }
          // An optional mapping with no producer value contributes nothing.
          continue;
        }
        const value = resolvedValue.value;
        values[mapping.to] = value;
        injectedValues[mapping.to] = value;
        if (sensitive) sensitiveValues[mapping.to] = value;
      }
      // Pin the snapshot entry even when no producer output existed yet so the
      // apply-time tamper check has the full edge set. The values digest is over
      // the FULL plaintext value map (sensitive + non-sensitive) so it is
      // independent of at-rest sealing.
      const valuesDigest = await stableJsonDigest(values);
      // Seal the sensitive subset OUT of the cleartext `values` map: a resolved
      // `published_output` secret must never land as a cleartext ledger value
      // (spec §11 / §18). The digest above already covered the full plaintext.
      const sensitiveNames = Object.keys(sensitiveValues);
      let cleartextValues: Record<string, JsonValue> = values;
      let sealedValues: SealedDependencyValues | undefined;
      if (sensitiveNames.length > 0) {
        hasSensitiveInjected = true;
        if (!this.#dependencyValueSealer) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `dependency_value_sealer_unavailable: dependency ${dependency.id} ` +
              `resolved sensitive output(s) ${sensitiveNames.join(", ")} but no ` +
              `at-rest value sealer is configured`,
          );
        }
        sealedValues = await this.#dependencyValueSealer.seal(sensitiveValues);
        cleartextValues = Object.fromEntries(
          Object.entries(values).filter(
            ([key]) =>
              !Object.prototype.hasOwnProperty.call(sensitiveValues, key),
          ),
        );
      }
      entries.push({
        dependencyId: dependency.id,
        producerCapsuleId: producer.id,
        producerInstallationId: producer.id,
        producerStateGeneration: producer.currentStateGeneration,
        producerOutputId: outputSnapshot?.id ?? "",
        producerOutputDigest: outputSnapshot?.outputDigest ?? "",
        valuesDigest,
        values: cleartextValues,
        ...(sealedValues ? { sealedValues } : {}),
      });
    }
    const mode: DependencySnapshotMode =
      consumer.environment.trim().toLowerCase() === "production"
        ? "strict"
        : "pinned";
    return {
      injectedValues,
      hasSensitiveInjected,
      entries,
      mode,
    };
  }

  /**
   * Resolves the ACTIVE OutputShare coverage for a `published_output` edge (spec
   * §18) into a SHARED-name -> producer-output-name map. Reads the consumer
   * Space's shares granted by the producer Space for this producer Installation,
   * keeps only `active` grants, and exposes each entry under its SHARED name (the
   * grant `alias` when set, else its `name`) mapped to the producer output name.
   * A revoked grant simply drops its entries from the map, so a mapped name the
   * grant no longer covers surfaces as `output_share_revoked` upstream. Re-run at
   * BOTH plan and apply (the apply path re-resolves consumer dependencies),
   * so a revoke between plan and apply fails the apply.
   */
  async resolveShareCoverage(
    producer: Installation,
    consumer: Installation,
  ): Promise<ShareCoverage> {
    const shares = await this.#store.listOutputSharesToSpace((consumer.workspaceId ?? consumer.spaceId));
    const coverage = new Map<
      string,
      { readonly outputName: string; readonly sensitive: boolean }
    >();
    for (const share of shares) {
      if (
        share.status !== "active" ||
        share.fromSpaceId !== producer.spaceId ||
        share.producerInstallationId !== producer.id
      )
        continue;
      for (const entry of share.outputs) {
        coverage.set(entry.alias ?? entry.name, {
          outputName: entry.name,
          sensitive: entry.sensitive === true,
        });
      }
    }
    return coverage;
  }

  async #resolveDependencyOutputValue(input: {
    readonly dependencyId: string;
    readonly producer: Installation;
    readonly consumer: Installation;
    readonly outputSnapshot: OutputSnapshot | undefined;
    readonly producerOutputName: string;
    readonly sensitive: boolean;
  }): Promise<{ readonly value: JsonValue } | undefined> {
    if (!input.sensitive) {
      const available = input.outputSnapshot?.spaceOutputs ?? {};
      if (
        !Object.prototype.hasOwnProperty.call(
          available,
          input.producerOutputName,
        )
      ) {
        return undefined;
      }
      return { value: available[input.producerOutputName] as JsonValue };
    }
    if (!input.outputSnapshot) return undefined;
    if (!this.#sensitiveOutputResolver) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `sensitive_output_resolver_unavailable: dependency ${input.dependencyId} ` +
          `requires sensitive output ${input.producerOutputName}`,
      );
    }
    const resolved: SensitiveOutputValue | undefined =
      await this.#sensitiveOutputResolver.resolve({
        outputSnapshot: input.outputSnapshot,
        outputName: input.producerOutputName,
        fromSpaceId: (input.producer.workspaceId ?? input.producer.spaceId),
        toSpaceId: (input.consumer.workspaceId ?? input.consumer.spaceId),
        producerInstallationId: input.producer.id,
      });
    if (!resolved) return undefined;
    return { value: resolved.value };
  }

  async #latestProducerStateSnapshotForDependency(
    dependencyId: string,
    producer: Installation,
  ): Promise<StateSnapshot> {
    const stateSnapshot = await this.#store.getLatestStateSnapshot(
      producer.id,
      producer.environment,
    );
    if (!stateSnapshot) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `dependency_state_unavailable: dependency ${dependencyId} producer ` +
          `installation ${producer.id} has no StateSnapshot yet (apply it first)`,
      );
    }
    return stateSnapshot;
  }
}
