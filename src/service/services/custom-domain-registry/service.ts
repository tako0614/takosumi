import { conflict, invalidArgument, notFound } from "../../shared/errors.ts";
import {
  canonicalHostname,
  type CustomDomainReservationStore,
} from "./store.ts";
import type {
  CustomDomainReservation,
  CustomDomainReservationOwner,
  ReleaseCustomDomainInput,
  ReserveCustomDomainInput,
  VerifyCustomDomainInput,
} from "./types.ts";

export interface CustomDomainRegistryServiceOptions {
  readonly store: CustomDomainReservationStore;
  readonly clock?: () => Date;
}

/**
 * Cross-tenant custom domain reservation service.
 *
 * Provider materializers (Cloudflare custom hostname, AWS ACM custom domain,
 * GCP managed certificate, k8s ingress with cert-manager) MUST acquire a
 * reservation via {@link reserve} before mutating upstream DNS / certificate
 * state. The hostname column carries a unique constraint at the storage layer;
 * a second tenant requesting the same hostname while the first reservation is
 * still `pending` or `verified` triggers a `conflict` error and is surfaced to
 * the deploy plan as HTTP 409 by the routing API gateway.
 *
 * On rollback / uninstall the materializer calls {@link release} (typically
 * gating the call on the original owner) so the hostname becomes claimable
 * again.
 */
export class CustomDomainRegistryService {
  readonly #store: CustomDomainReservationStore;
  readonly #clock: () => Date;

  constructor(options: CustomDomainRegistryServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Atomically reserve `hostname` for the requested owner. Re-claiming the
   * same hostname for the same `(tenantId, groupId, deploymentId)` triple is
   * idempotent. Any other owner is rejected with a `conflict` error.
   */
  async reserve(
    input: ReserveCustomDomainInput,
  ): Promise<CustomDomainReservation> {
    assertHostname(input.hostname);
    assertOwner(input);
    const owner: CustomDomainReservationOwner = Object.freeze({
      tenantId: input.tenantId,
      groupId: input.groupId,
      deploymentId: input.deploymentId,
    });
    const reservedAt = this.#now();
    const claim = await this.#store.claim({
      hostname: input.hostname,
      owner,
      status: input.status ?? "pending",
      reservedAt,
    });
    if (!sameOwner(claim.owner, owner)) {
      throw conflict("Custom domain hostname is already reserved", {
        hostname: canonicalHostname(input.hostname),
        existingOwner: { ...claim.owner },
        requestedOwner: { ...owner },
        existingStatus: claim.status,
      });
    }
    return claim;
  }

  /**
   * Mark a previously-pending reservation as verified once the upstream
   * provider confirmed DNS / SSL ownership.
   */
  async verify(
    input: VerifyCustomDomainInput,
  ): Promise<CustomDomainReservation> {
    assertHostname(input.hostname);
    const existing = await this.#store.get(input.hostname);
    if (!existing) {
      throw notFound("Custom domain reservation not found", {
        hostname: canonicalHostname(input.hostname),
      });
    }
    if (existing.status === "released") {
      throw conflict(
        "Cannot verify a released custom domain reservation",
        {
          hostname: canonicalHostname(input.hostname),
        },
      );
    }
    if (!sameOwner(existing.owner, input.owner)) {
      throw conflict("Custom domain reservation owner mismatch", {
        hostname: canonicalHostname(input.hostname),
        existingOwner: { ...existing.owner },
        requestedOwner: { ...input.owner },
      });
    }
    const updated = await this.#store.updateStatus({
      hostname: input.hostname,
      status: "verified",
      updatedAt: this.#now(),
    });
    if (!updated) {
      throw notFound("Custom domain reservation disappeared", {
        hostname: canonicalHostname(input.hostname),
      });
    }
    return updated;
  }

  /**
   * Release a reservation, optionally gating on the recorded owner.
   *
   * Materializers pass the owner from the rolling-back / uninstalling
   * deployment to defend against race conditions where another deployment
   * may have already taken over the hostname.
   */
  async release(
    input: ReleaseCustomDomainInput,
  ): Promise<CustomDomainReservation | undefined> {
    assertHostname(input.hostname);
    const existing = await this.#store.get(input.hostname);
    if (!existing) return undefined;
    if (existing.status === "released") return existing;
    if (input.owner && !sameOwner(existing.owner, input.owner)) {
      throw conflict(
        "Cannot release custom domain reservation owned by a different deployment",
        {
          hostname: canonicalHostname(input.hostname),
          existingOwner: { ...existing.owner },
          requestedOwner: { ...input.owner },
        },
      );
    }
    return await this.#store.release(input.hostname, this.#now());
  }

  get(hostname: string): Promise<CustomDomainReservation | undefined> {
    assertHostname(hostname);
    return this.#store.get(hostname);
  }

  listByOwner(
    tenantId: string,
    groupId?: string,
  ): Promise<readonly CustomDomainReservation[]> {
    if (!tenantId) {
      throw invalidArgument("tenantId is required");
    }
    return this.#store.listByOwner(tenantId, groupId);
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function assertHostname(hostname: string | undefined): void {
  if (!hostname || !hostname.trim()) {
    throw invalidArgument("hostname is required");
  }
}

function assertOwner(input: ReserveCustomDomainInput): void {
  if (!input.tenantId) throw invalidArgument("tenantId is required");
  if (!input.groupId) throw invalidArgument("groupId is required");
  if (!input.deploymentId) throw invalidArgument("deploymentId is required");
}

function sameOwner(
  a: CustomDomainReservationOwner,
  b: CustomDomainReservationOwner,
): boolean {
  return a.tenantId === b.tenantId &&
    a.groupId === b.groupId &&
    a.deploymentId === b.deploymentId;
}
