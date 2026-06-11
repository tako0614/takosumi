/**
 * OutputShares domain service (Core Specification §18).
 *
 * An OutputShare is the explicit cross-Space sharing grant: it authorizes a
 * consumer Space (`toSpace`) to consume named outputs from a producer
 * Installation that lives in another Space (`fromSpace`). It is the ONLY way
 * outputs cross a Space boundary (invariant 13); a same-Space dependency edge
 * never needs one.
 *
 * This service owns OutputShare creation / acceptance / listing / revocation and enforces
 * the structural invariants of a grant:
 *
 *   - the producer Installation must exist and belong to `fromSpaceId`;
 *   - the consumer Space (`toSpaceId`) must exist;
 *   - `fromSpaceId` and `toSpaceId` must differ (a same-Space "share" is a
 *     Dependency, not an OutputShare);
 *   - the outputs list must be non-empty and every requested name must exist in
 *     the producer's LATEST OutputSnapshot.spaceOutputs (`failed_precondition`
 *     otherwise — you cannot grant an output the producer has not projected);
 *   - sensitive entries require an explicit policy acknowledgement on the
 *     request plus a host-injected resolver that proves the producer's encrypted
 *     raw output artifact contains that name with `sensitive: true`. The share
 *     record and Activity still store names/flags only; the sensitive value is
 *     resolved only at plan-time `published_output` injection.
 *
 * Status lifecycle: a created share starts `pending`, the receiving Space calls
 * approve/accept to move it to `active`, and `revoke` moves a pending or active
 * share to `revoked`.
 *
 * The plan-time `published_output` consumption (injecting a shared output into a
 * consumer Installation's variables, pinned by a DependencySnapshot) lands in a
 * later phase in the dependencies domain + controller; this service is the grant
 * CRUD + structural gate.
 */

import type {
  OutputShare,
  OutputShareEntry,
  OutputSnapshot,
} from "takosumi-contract/output-snapshots";
import type { JsonValue } from "takosumi-contract";
import { OpenTofuControllerError, requireNonEmptyString } from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";

/** One requested output entry on a create-share request. */
export interface CreateOutputShareEntry {
  /** Producer output name (must exist in the latest OutputSnapshot.spaceOutputs). */
  readonly name: string;
  /** Optional consumer-side rename; defaults to `name` when omitted. */
  readonly alias?: string;
  /** Marks a sensitive output name. Requires `sensitivePolicy.allow === true`. */
  readonly sensitive?: boolean;
}

export interface SensitiveOutputSharePolicy {
  readonly allow: boolean;
  readonly reason?: string;
}

export interface SensitiveOutputValue {
  readonly value: JsonValue;
  readonly sensitive: true;
}

/**
 * Host-injected resolver for sensitive output values. The service core only sees
 * the latest OutputSnapshot pointer and the requested output name; the host owns
 * decrypting the encrypted raw output artifact. Implementations must return a
 * value only when the raw OpenTofu output exists and is flagged sensitive.
 */
export interface SensitiveOutputResolver {
  resolve(input: {
    readonly outputSnapshot: OutputSnapshot;
    readonly outputName: string;
    readonly fromSpaceId: string;
    readonly toSpaceId: string;
    readonly producerInstallationId: string;
  }): Promise<SensitiveOutputValue | undefined>;
}

/** Create-share request: the public {@link OutputShare} minus the service-assigned fields. */
export interface CreateOutputShareRequest {
  readonly fromSpaceId: string;
  readonly toSpaceId: string;
  readonly producerInstallationId: string;
  readonly outputs: readonly CreateOutputShareEntry[];
  readonly sensitivePolicy?: SensitiveOutputSharePolicy;
}

export interface OutputSharesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  /** Space-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
  /**
   * Optional sensitive-output resolver. Required for creating sensitive shares:
   * without it the service fails closed rather than granting an unverifiable raw
   * output name. The resolver never affects public/list responses.
   */
  readonly sensitiveOutputResolver?: SensitiveOutputResolver;
}

export class OutputSharesService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #activity: ActivityRecorder;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;

  constructor(dependencies: OutputSharesServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId ??
      ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#sensitiveOutputResolver = dependencies.sensitiveOutputResolver;
  }

  /**
   * Creates an OutputShare after enforcing every structural invariant (spec
   * §18). The producer Installation must exist and belong to `fromSpaceId`; the
   * consumer Space must exist; `fromSpaceId` != `toSpaceId`; the outputs list is
   * non-empty; every requested name exists in the producer's latest
   * OutputSnapshot.spaceOutputs; and sensitive entries carry an explicit policy
   * acknowledgement. The created share is PENDING until the receiving Space
   * approves it.
   */
  async createShare(request: CreateOutputShareRequest): Promise<OutputShare> {
    requireNonEmptyString(request.fromSpaceId, "fromSpaceId");
    requireNonEmptyString(request.toSpaceId, "toSpaceId");
    requireNonEmptyString(
      request.producerInstallationId,
      "producerInstallationId",
    );
    // A "share" within one Space is a Dependency, not an OutputShare: the
    // cross-Space boundary is the whole point of the grant.
    if (request.fromSpaceId === request.toSpaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "an output share must cross a Space boundary (fromSpaceId must differ " +
          "from toSpaceId; use a Dependency for same-Space output flow)",
      );
    }
    // The grant must name at least one output; an empty grant authorizes nothing.
    if (request.outputs.length === 0) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "output share must declare at least one output to share",
      );
    }
    const entries = normalizeEntries(request.outputs, request.sensitivePolicy);

    const producer = await this.#store.getInstallation(
      request.producerInstallationId,
    );
    if (!producer) {
      throw new OpenTofuControllerError(
        "not_found",
        `producer installation ${request.producerInstallationId} not found`,
      );
    }
    // The producer must belong to the granting Space: a Space can only share the
    // outputs of its OWN Installations.
    if (producer.spaceId !== request.fromSpaceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `producer installation ${request.producerInstallationId} belongs to ` +
          `space ${producer.spaceId}, not the granting space ${request.fromSpaceId}`,
      );
    }
    // The consumer Space must exist (you cannot grant to nothing).
    const toSpace = await this.#store.getSpace(request.toSpaceId);
    if (!toSpace) {
      throw new OpenTofuControllerError(
        "not_found",
        `consumer space ${request.toSpaceId} not found`,
      );
    }

    // Every non-sensitive shared name must exist in the producer's LATEST
    // projected spaceOutputs: you cannot grant an ordinary output the producer
    // has not produced. Sensitive entries are not stored in spaceOutputs; they
    // require explicit policy plus a host resolver that re-checks the encrypted
    // raw output artifact before plan-time published_output injection.
    const latest = await this.#store.getLatestOutputSnapshot(
      request.producerInstallationId,
    );
    const available = new Set(
      latest ? Object.keys(latest.spaceOutputs) : [],
    );
    const missing = entries
      .filter((entry) => entry.sensitive !== true)
      .map((entry) => entry.name)
      .filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `output share names not present in the producer's latest output ` +
        `snapshot: ${missing.join(", ")}`,
      );
    }
    const sensitiveEntries = entries.filter((entry) => entry.sensitive === true);
    if (sensitiveEntries.length > 0) {
      if (!latest) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "sensitive output share requires a latest producer OutputSnapshot",
        );
      }
      if (!this.#sensitiveOutputResolver) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "sensitive output sharing requires a configured sensitive output resolver",
        );
      }
      for (const entry of sensitiveEntries) {
        const resolved = await this.#sensitiveOutputResolver.resolve({
          outputSnapshot: latest,
          outputName: entry.name,
          fromSpaceId: request.fromSpaceId,
          toSpaceId: request.toSpaceId,
          producerInstallationId: request.producerInstallationId,
        });
        if (!resolved) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `sensitive output ${entry.name} is not present as a sensitive ` +
              "output in the producer's latest raw output artifact",
          );
        }
      }
    }

    const share: OutputShare = {
      id: this.#newId("oshare"),
      fromSpaceId: request.fromSpaceId,
      toSpaceId: request.toSpaceId,
      producerInstallationId: request.producerInstallationId,
      outputs: entries,
      status: "pending",
      createdAt: this.#now(),
    };
    const created = await this.#store.putOutputShare(share);
    // Activity (§27 / §34): an OutputShare was granted. Recorded against the
    // GRANTING Space (fromSpaceId, the side that authorizes the share). Names +
    // aliases only — never output VALUES.
    await this.#activity.record({
      spaceId: created.fromSpaceId,
      action: "output_share.created",
      targetType: "output_share",
      targetId: created.id,
      metadata: {
        toSpaceId: created.toSpaceId,
        producerInstallationId: created.producerInstallationId,
        outputNames: created.outputs.map((entry) => entry.name),
        sensitiveOutputNames: created.outputs
          .filter((entry) => entry.sensitive)
          .map((entry) => entry.name),
      },
    });
    return created;
  }

  /**
   * Lists every OutputShare touching a Space — both the grants it GRANTED
   * (`fromSpaceId === spaceId`) and the grants it RECEIVED (`toSpaceId ===
   * spaceId`) — de-duplicated and ordered oldest-first.
   */
  async listForSpace(spaceId: string): Promise<readonly OutputShare[]> {
    requireNonEmptyString(spaceId, "spaceId");
    const [granted, received] = await Promise.all([
      this.#store.listOutputSharesFromSpace(spaceId),
      this.#store.listOutputSharesToSpace(spaceId),
    ]);
    const byId = new Map<string, OutputShare>();
    for (const share of [...granted, ...received]) byId.set(share.id, share);
    return Array.from(byId.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  }

  /** Reads an OutputShare by id (used by routes for space-permission gating). */
  async getShare(id: string): Promise<OutputShare | undefined> {
    requireNonEmptyString(id, "shareId");
    return await this.#store.getOutputShare(id);
  }

  /**
   * Approves a pending OutputShare from the receiving Space side. Active shares
   * are idempotent; revoked shares cannot be reactivated.
   */
  async approveShare(id: string): Promise<OutputShare> {
    requireNonEmptyString(id, "shareId");
    const existing = await this.#store.getOutputShare(id);
    if (!existing) {
      throw new OpenTofuControllerError(
        "not_found",
        `output share ${id} not found`,
      );
    }
    if (existing.status === "active") return existing;
    if (existing.status === "revoked") {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `output share ${id} has been revoked and cannot be approved`,
      );
    }
    const active: OutputShare = {
      ...existing,
      status: "active",
      acceptedAt: this.#now(),
    };
    const stored = await this.#store.putOutputShare(active);
    await this.#activity.record({
      spaceId: stored.toSpaceId,
      action: "output_share.approved",
      targetType: "output_share",
      targetId: stored.id,
      metadata: {
        fromSpaceId: stored.fromSpaceId,
        producerInstallationId: stored.producerInstallationId,
        outputNames: stored.outputs.map((entry) => entry.name),
        sensitiveOutputNames: stored.outputs
          .filter((entry) => entry.sensitive)
          .map((entry) => entry.name),
      },
    });
    return stored;
  }

  /**
   * Revokes an OutputShare: moves it to `revoked` and stamps `revokedAt`. A
   * missing share is `not_found`; an already-revoked share is returned
   * unchanged (idempotent). Spec §18.
   */
  async revokeShare(id: string): Promise<OutputShare> {
    requireNonEmptyString(id, "shareId");
    const existing = await this.#store.getOutputShare(id);
    if (!existing) {
      throw new OpenTofuControllerError(
        "not_found",
        `output share ${id} not found`,
      );
    }
    if (existing.status === "revoked") return existing;
    const revoked: OutputShare = {
      ...existing,
      status: "revoked",
      revokedAt: this.#now(),
    };
    const stored = await this.#store.putOutputShare(revoked);
    // Activity (§27 / §34): an OutputShare was revoked. Recorded against the
    // granting Space (the side that owns the grant).
    await this.#activity.record({
      spaceId: stored.fromSpaceId,
      action: "output_share.revoked",
      targetType: "output_share",
      targetId: stored.id,
      metadata: {
        toSpaceId: stored.toSpaceId,
        producerInstallationId: stored.producerInstallationId,
      },
    });
    return stored;
  }
}

/**
 * Validates + normalizes the requested entries into stored {@link
 * OutputShareEntry} records. Each `name` must be non-empty; an explicit `alias`
 * must be non-empty when present; `sensitive: true` requires explicit policy;
 * and a duplicate `name` is rejected `invalid_argument`. Stored entries carry
 * only names / aliases / sensitive flags, never output values.
 */
function normalizeEntries(
  outputs: readonly CreateOutputShareEntry[],
  sensitivePolicy?: SensitiveOutputSharePolicy,
): readonly OutputShareEntry[] {
  const seen = new Set<string>();
  const entries: OutputShareEntry[] = [];
  for (const entry of outputs) {
    requireNonEmptyString(entry.name, "outputs[].name");
    if (entry.alias !== undefined) {
      requireNonEmptyString(entry.alias, `outputs.${entry.name}.alias`);
    }
    if (entry.sensitive === true) {
      if (sensitivePolicy?.allow !== true) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `sharing sensitive output ${entry.name} requires explicit ` +
            "sensitivePolicy.allow",
        );
      }
      if (sensitivePolicy.reason?.trim()) {
        // The reason is intentionally not persisted on the OutputShare record or
        // activity metadata; it is an explicit request-time acknowledgement.
      } else {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "sensitivePolicy.reason is required for sensitive output sharing",
        );
      }
    }
    if (seen.has(entry.name)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `output share names must be unique; ${entry.name} is duplicated`,
      );
    }
    seen.add(entry.name);
    entries.push({
      name: entry.name,
      ...(entry.alias !== undefined ? { alias: entry.alias } : {}),
      sensitive: entry.sensitive === true,
    });
  }
  return entries;
}
