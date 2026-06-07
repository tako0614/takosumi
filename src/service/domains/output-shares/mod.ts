/**
 * OutputShares domain service (Core Specification §18).
 *
 * An OutputShare is the explicit cross-Space sharing grant: it authorizes a
 * consumer Space (`toSpace`) to consume named outputs from a producer
 * Installation that lives in another Space (`fromSpace`). It is the ONLY way
 * outputs cross a Space boundary (invariant 13); a same-Space dependency edge
 * never needs one.
 *
 * This service owns OutputShare creation / listing / revocation and enforces
 * the structural invariants of a grant:
 *
 *   - the producer Installation must exist and belong to `fromSpaceId`;
 *   - the consumer Space (`toSpaceId`) must exist;
 *   - `fromSpaceId` and `toSpaceId` must differ (a same-Space "share" is a
 *     Dependency, not an OutputShare);
 *   - the outputs list must be non-empty and every requested name must exist in
 *     the producer's LATEST OutputSnapshot.spaceOutputs (`failed_precondition`
 *     otherwise — you cannot grant an output the producer has not projected);
 *   - sensitive sharing is NOT supported: every stored entry is `sensitive:
 *     false`, and a request that tries to set `sensitive: true` is rejected
 *     `not_implemented` (invariant 12 — secret values never cross a Space
 *     boundary through the public ledger).
 *
 * Status lifecycle (single-operator instance): a created share goes ACTIVE
 * directly. The spec's `pending` handshake (the consumer Space explicitly
 * accepting an incoming grant) is a later multi-tenant concern; on a
 * single-operator instance the operator already controls both Spaces, so there
 * is no counter-party to wait on. `revoke` moves an ACTIVE share to `revoked`.
 *
 * The plan-time `published_output` consumption (injecting a shared output into a
 * consumer Installation's variables, pinned by a DependencySnapshot) lands in a
 * later phase in the dependencies domain + controller; this service is the grant
 * CRUD + structural gate.
 */

import type {
  OutputShare,
  OutputShareEntry,
} from "takosumi-contract/output-snapshots";
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
  /**
   * Sensitive sharing is not supported (invariant 12). Present only so a request
   * setting it `true` can be rejected `not_implemented`; stored entries are
   * always `sensitive: false`.
   */
  readonly sensitive?: boolean;
}

/** Create-share request: the public {@link OutputShare} minus the service-assigned fields. */
export interface CreateOutputShareRequest {
  readonly fromSpaceId: string;
  readonly toSpaceId: string;
  readonly producerInstallationId: string;
  readonly outputs: readonly CreateOutputShareEntry[];
}

export interface OutputSharesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  /** Space-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
}

export class OutputSharesService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #activity: ActivityRecorder;

  constructor(dependencies: OutputSharesServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId = dependencies.newId ??
      ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
  }

  /**
   * Creates an OutputShare after enforcing every structural invariant (spec
   * §18). The producer Installation must exist and belong to `fromSpaceId`; the
   * consumer Space must exist; `fromSpaceId` != `toSpaceId`; the outputs list is
   * non-empty; every requested name exists in the producer's latest
   * OutputSnapshot.spaceOutputs; and no entry requests `sensitive: true`. The
   * created share is ACTIVE.
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
    const entries = normalizeEntries(request.outputs);

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

    // Every shared name must exist in the producer's LATEST projected
    // spaceOutputs: you cannot grant an output the producer has not produced.
    const latest = await this.#store.getLatestOutputSnapshot(
      request.producerInstallationId,
    );
    const available = new Set(
      latest ? Object.keys(latest.spaceOutputs) : [],
    );
    const missing = entries
      .map((entry) => entry.name)
      .filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `output share names not present in the producer's latest output ` +
          `snapshot: ${missing.join(", ")}`,
      );
    }

    const share: OutputShare = {
      id: this.#newId("oshare"),
      fromSpaceId: request.fromSpaceId,
      toSpaceId: request.toSpaceId,
      producerInstallationId: request.producerInstallationId,
      outputs: entries,
      // Single-operator instance: an OutputShare is created ACTIVE directly. The
      // spec `pending` handshake (consumer Space accepting an incoming grant) is
      // a later multi-tenant concern.
      status: "active",
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
 * must be non-empty when present; `sensitive: true` is rejected
 * `not_implemented` (invariant 12); and a duplicate `name` is rejected
 * `invalid_argument`. Stored entries always carry `sensitive: false`.
 */
function normalizeEntries(
  outputs: readonly CreateOutputShareEntry[],
): readonly OutputShareEntry[] {
  const seen = new Set<string>();
  const entries: OutputShareEntry[] = [];
  for (const entry of outputs) {
    requireNonEmptyString(entry.name, "outputs[].name");
    if (entry.alias !== undefined) {
      requireNonEmptyString(entry.alias, `outputs.${entry.name}.alias`);
    }
    // Sensitive sharing is not supported (invariant 12): secret values must not
    // cross a Space boundary through the public ledger.
    if (entry.sensitive === true) {
      throw new OpenTofuControllerError(
        "not_implemented",
        `sharing sensitive output ${entry.name} is not supported ` +
          "(sensitive values never cross a Space boundary)",
      );
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
      sensitive: false,
    });
  }
  return entries;
}
