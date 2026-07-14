/**
 * OutputShares domain service (Core Specification §18).
 *
 * An OutputShare is the explicit cross-Workspace sharing grant: it authorizes a
 * consumer Workspace to consume named outputs from a producer Capsule that
 * lives in another Workspace. It is the ONLY way outputs cross a Workspace
 * boundary (invariant 13); a same-Workspace dependency edge
 * never needs one.
 *
 * This service owns OutputShare creation / acceptance / listing / revocation and enforces
 * the structural invariants of a grant:
 *
 *   - the producer Capsule must exist and belong to `fromWorkspaceId`;
 *   - the consumer Workspace (`toWorkspaceId`) must exist;
 *   - `fromWorkspaceId` and `toWorkspaceId` must differ (a same-Workspace share is a
 *     Dependency, not an OutputShare);
 *   - the outputs list must be non-empty and every requested name must exist in
 *     the producer's latest Output.workspaceOutputs (`failed_precondition`
 *     otherwise — you cannot grant an output the producer has not projected);
 *   - sensitive entries require an explicit policy acknowledgement on the
 *     request plus a host-injected resolver that proves the producer's encrypted
 *     raw output artifact contains that name with `sensitive: true`. The share
 *     record and Activity still store names/flags only; the sensitive value is
 *     resolved only at plan-time `published_output` injection.
 *
 * Status lifecycle: a created share starts `pending`, the receiving Workspace calls
 * approve/accept to move it to `active`, and `revoke` moves a pending or active
 * share to `revoked`.
 *
 * The plan-time `published_output` consumption (injecting a shared output into a
 * consumer Capsule's variables, pinned by a DependencySnapshot) lands in a
 * later phase in the dependencies domain + controller; this service is the grant
 * CRUD + structural gate.
 */

import type {
  OutputShare,
  OutputShareEntry,
  Output as Output,
} from "takosumi-contract/outputs";
import type { JsonValue } from "takosumi-contract";
import {
  type Page,
  type PageParams,
  pageSorted,
} from "takosumi-contract/pagination";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import {
  type ActivityRecorder,
  NOOP_ACTIVITY_RECORDER,
} from "../activity/mod.ts";

/** One requested output entry on a create-share request. */
export interface CreateOutputShareEntry {
  /** Producer output name (must exist in the latest Output.workspaceOutputs). */
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
 * the latest Output pointer and the requested output name; the host owns
 * decrypting the encrypted raw output artifact. Implementations must return a
 * value only when the raw OpenTofu output exists and is flagged sensitive.
 */
export interface SensitiveOutputResolver {
  resolve(input: {
    readonly output: Output;
    readonly outputName: string;
    readonly fromWorkspaceId: string;
    readonly toWorkspaceId: string;
    readonly producerCapsuleId: string;
  }): Promise<SensitiveOutputValue | undefined>;
}

/** Create-share request: the public {@link OutputShare} minus the service-assigned fields. */
export interface CreateOutputShareRequest {
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly producerCapsuleId: string;
  readonly outputs: readonly CreateOutputShareEntry[];
  readonly sensitivePolicy?: SensitiveOutputSharePolicy;
}

export interface OutputSharesServiceDependencies {
  readonly store: OpenTofuControlStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => string;
  /** Workspace-scoped Activity audit trail (spec §27 / §34). Defaults to no-op. */
  readonly activity?: ActivityRecorder;
  /**
   * Optional sensitive-output resolver. Required for creating sensitive shares:
   * without it the service fails closed rather than granting an unverifiable raw
   * output name. The resolver never affects public/list responses.
   */
  readonly sensitiveOutputResolver?: SensitiveOutputResolver;
}

export class OutputSharesService {
  readonly #store: OpenTofuControlStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => string;
  readonly #activity: ActivityRecorder;
  readonly #sensitiveOutputResolver?: SensitiveOutputResolver;

  constructor(dependencies: OutputSharesServiceDependencies) {
    this.#store = dependencies.store;
    this.#newId =
      dependencies.newId ??
      ((prefix) =>
        `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#activity = dependencies.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#sensitiveOutputResolver = dependencies.sensitiveOutputResolver;
  }

  /**
   * Creates an OutputShare after enforcing every structural invariant (spec
   * §18). The producer Capsule must exist and belong to `fromWorkspaceId`; the
   * consumer Workspace must exist; both Workspace ids must differ; the outputs list is
   * non-empty; every requested name exists in the producer's latest
   * Output.workspaceOutputs; and sensitive entries carry an explicit policy
   * acknowledgement. The created share is PENDING until the receiving Workspace
   * approves it.
   */
  async createShare(request: CreateOutputShareRequest): Promise<OutputShare> {
    const fromWorkspaceId = request.fromWorkspaceId;
    const toWorkspaceId = request.toWorkspaceId;
    const producerCapsuleId = request.producerCapsuleId;
    requireNonEmptyString(fromWorkspaceId, "fromWorkspaceId");
    requireNonEmptyString(toWorkspaceId, "toWorkspaceId");
    requireNonEmptyString(producerCapsuleId, "producerCapsuleId");
    // A share within one Workspace is a Dependency, not an OutputShare.
    if (fromWorkspaceId === toWorkspaceId) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "an output share must cross a Workspace boundary; use a Dependency for same-Workspace output flow",
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

    const producer = await this.#store.getCapsule(producerCapsuleId);
    if (!producer) {
      throw new OpenTofuControllerError(
        "not_found",
        `producer capsule ${producerCapsuleId} not found`,
      );
    }
    // The producer must belong to the granting Workspace.
    if (producer.workspaceId !== fromWorkspaceId) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "producer capsule is not available to the granting workspace",
      );
    }
    // The consumer Workspace must exist (you cannot grant to nothing).
    const toWorkspace = await this.#store.getWorkspace(toWorkspaceId);
    if (!toWorkspace) {
      throw new OpenTofuControllerError(
        "not_found",
        "consumer workspace not found",
      );
    }

    // Every non-sensitive shared name must exist in the producer's LATEST
    // projected workspaceOutputs: you cannot grant an ordinary output the producer
    // has not produced. Sensitive entries are not stored in workspaceOutputs; they
    // require explicit policy plus a host resolver that re-checks the encrypted
    // raw output artifact before plan-time published_output injection.
    const latest = await this.#store.getLatestOutput(producerCapsuleId);
    const available = new Set(
      latest ? Object.keys(latest.workspaceOutputs) : [],
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
    const sensitiveEntries = entries.filter(
      (entry) => entry.sensitive === true,
    );
    if (sensitiveEntries.length > 0) {
      if (!latest) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "sensitive output share requires a latest producer Output",
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
          output: latest,
          outputName: entry.name,
          fromWorkspaceId,
          toWorkspaceId,
          producerCapsuleId,
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
      fromWorkspaceId,
      toWorkspaceId,
      producerCapsuleId,
      outputs: entries,
      status: "pending",
      createdAt: this.#now(),
    };
    const created = await this.#store.putOutputShare(share);
    // Activity (§27 / §34): an OutputShare was granted. Recorded against the
    // granting Workspace (the side that authorizes the share). Names +
    // aliases only — never output VALUES.
    await this.#activity.record({
      workspaceId: created.fromWorkspaceId,
      action: "output_share.created",
      targetType: "output_share",
      targetId: created.id,
      metadata: {
        toWorkspaceId: created.toWorkspaceId,
        producerCapsuleId: created.producerCapsuleId,
        outputNames: created.outputs.map((entry) => entry.name),
        sensitiveOutputNames: created.outputs
          .filter((entry) => entry.sensitive)
          .map((entry) => entry.name),
      },
    });
    return created;
  }

  /**
   * Lists every OutputShare touching a Workspace — both grants and receipts —
   * de-duplicated and ordered oldest-first.
   */
  async listForWorkspace(workspaceId: string): Promise<readonly OutputShare[]> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const [granted, received] = await Promise.all([
      this.#store.listOutputSharesFromWorkspace(workspaceId),
      this.#store.listOutputSharesToWorkspace(workspaceId),
    ]);
    const byId = new Map<string, OutputShare>();
    for (const share of [...granted, ...received]) byId.set(share.id, share);
    return Array.from(byId.values()).sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  /**
   * Keyset-paged {@link listForWorkspace} (spec §30). The cross-Workspace
   * grants are a small set, so the union is materialized, de-duplicated, and
   * sorted by `(createdAt, id)` (by {@link listForWorkspace}), then bounded with the
   * in-memory keyset pager — a keyset across the UNION query would be unsound.
   */
  async listForWorkspacePage(
    workspaceId: string,
    params: PageParams,
  ): Promise<Page<OutputShare>> {
    return pageSorted(await this.listForWorkspace(workspaceId), params);
  }

  /** Reads an OutputShare by id (used by routes for Workspace-permission gating). */
  async getShare(id: string): Promise<OutputShare | undefined> {
    requireNonEmptyString(id, "shareId");
    return await this.#store.getOutputShare(id);
  }

  /**
   * Approves a pending OutputShare from the receiving Workspace side. Active shares
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
      workspaceId: stored.toWorkspaceId,
      action: "output_share.approved",
      targetType: "output_share",
      targetId: stored.id,
      metadata: {
        fromWorkspaceId: stored.fromWorkspaceId,
        producerCapsuleId: stored.producerCapsuleId,
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
    // granting Workspace (the side that owns the grant).
    await this.#activity.record({
      workspaceId: stored.fromWorkspaceId,
      action: "output_share.revoked",
      targetType: "output_share",
      targetId: stored.id,
      metadata: {
        toWorkspaceId: stored.toWorkspaceId,
        producerCapsuleId: stored.producerCapsuleId,
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
