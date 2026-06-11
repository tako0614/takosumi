/**
 * The membership facade that backs the account-plane
 * `/api/v1/spaces/:id/members` surface (`ControlPlaneOperations.members`).
 *
 * It bridges two stores that the rest of the system keeps deliberately separate:
 *
 *   - the Core-Spec `Space` (owner namespace `@handle`, owned by
 *     `domains/spaces`), which the route layer namespace-gates and whose
 *     `ownerUserId` is the membership root of trust, and
 *   - the membership domain's OWN `MembershipSpace` + membership ledger
 *     (`domains/membership`), against which
 *     `MembershipRoleEntitlementService.upsertSpaceMembership` enforces its two
 *     preconditions (`requireMembershipSpace` + `canManageSpace`).
 *
 * A Core-Spec Space is created with NO bridge into the membership domain, so for
 * a fresh Space neither precondition can ever be met: there is no MembershipSpace
 * row and no active owner ledger row. The route layer's implicit-owner projection
 * only satisfies the gate in its in-memory view; the domain re-reads the real
 * (empty) stores and fails closed (404 `not_found`, then 403 `permission_denied`).
 *
 * This facade closes that gap by self-bootstrapping the membership domain,
 * idempotently, before every mutation: it ensures the MembershipSpace exists and
 * that the NAMESPACE owner (resolved server-side, never from client input) holds
 * an active owner ledger row, so the domain gate passes for exactly the same
 * principal the route's `requireSpaceAccess` already trusts. It introduces no new
 * authority: only the namespace owner is ever seeded an owner row, and the
 * domain's own `canManageSpace` remains the defense-in-depth backstop for the
 * actual mutation actor.
 */

import type {
  MembershipDomainServices,
  MembershipSpaceStore,
  SpaceMembership,
  SpaceMembershipStore,
} from "./mod.ts";

/** The membership-service actor a control-route handler passes through. */
export interface MembershipControlActor {
  readonly actorAccountId: string;
  readonly roles: readonly string[];
  readonly requestId: string;
}

/** The mutation a control-route handler delegates to the membership facade. */
export interface MembershipControlUpsertInput {
  readonly spaceId: string;
  readonly accountId: string;
  readonly roles?: readonly SpaceMembership["roles"][number][];
  readonly status?: SpaceMembership["status"];
  readonly actor: MembershipControlActor;
}

/**
 * The structural `members` facade the account-plane control routes call
 * (`ControlPlaneOperations.members`). Kept dependency-free so both the host
 * bootstrap and tests can share the SAME real wiring.
 */
export interface MembershipControlFacade {
  listMembers(spaceId: string): Promise<readonly SpaceMembership[]>;
  upsertMember(input: MembershipControlUpsertInput): Promise<SpaceMembership>;
}

/**
 * Resolves the Core-Spec Space's namespace owner server-side. The host passes a
 * thin resolver over `SpacesService.getSpace` so this module never imports the
 * spaces domain (or the shared ledger) directly.
 */
export interface NamespaceSpaceResolver {
  (spaceId: string): Promise<{
    readonly ownerUserId: string;
    readonly displayName?: string;
    readonly handle?: string;
  }>;
}

export interface MembershipControlFacadeDependencies {
  /** The wired membership domain services (real, not a fake roster). */
  readonly membership: MembershipDomainServices;
  /** The membership domain's MembershipSpace store (its own, not the ledger Space). */
  readonly membershipSpaceStore: MembershipSpaceStore;
  /** The membership domain's space-membership ledger store. */
  readonly membershipLedgerStore: SpaceMembershipStore;
  /** Resolves the Core-Spec Space's namespace owner server-side. */
  readonly resolveSpace: NamespaceSpaceResolver;
  /** Injectable clock for deterministic timestamps in tests. */
  readonly now?: () => Date;
}

/**
 * Builds the membership `members` facade with the bootstrap bridge baked in.
 * `listMembers` is a pass-through (no gate; the route gates on membership). Every
 * `upsertMember` first ensures the membership domain is bootstrapped for the
 * Space's namespace owner, then delegates to the real
 * `MembershipRoleEntitlementService.upsertSpaceMembership`, which still enforces
 * its `canManageSpace` gate against the (now-bootstrapped) ledger.
 */
export function createMembershipControlFacade(
  deps: MembershipControlFacadeDependencies,
): MembershipControlFacade {
  const now = deps.now ?? (() => new Date());
  const memberships = deps.membership.memberships;

  const ensureBootstrap = async (spaceId: string): Promise<void> => {
    const space = await deps.resolveSpace(spaceId);
    const ownerUserId = space.ownerUserId;
    // Create the MembershipSpace row (+ its seeded owner ledger row for the
    // namespace owner) on first touch. `createSpace` seeds an active owner row
    // for `actor.actorAccountId`, so pass the NAMESPACE owner, not the caller.
    const existingSpace = await deps.membershipSpaceStore.get(spaceId);
    if (!existingSpace) {
      const created = await deps.membership.spaces.createSpace({
        spaceId,
        name: space.displayName || space.handle || spaceId,
        actor: {
          actorAccountId: ownerUserId,
          roles: ["owner"],
          requestId: `bootstrap-${spaceId}-${now().getTime()}`,
        },
      });
      // A concurrent bootstrap may have created the row first (`conflict`); any
      // other failure is real and must surface to the caller.
      if (!created.ok && created.error.code !== "conflict") {
        throw Object.assign(new Error(created.error.message), {
          code: created.error.code,
        });
      }
    }
    // Guarantee the namespace owner holds an ACTIVE owner ledger row even if the
    // MembershipSpace already existed without one. Written directly to the
    // ledger store because `upsertSpaceMembership` would itself require an
    // existing owner — the chicken-and-egg this bridge exists to break. It only
    // ever grants the namespace owner their OWN owner row; it never touches any
    // other account and never trusts client input.
    const ownerLedger = await deps.membershipLedgerStore.get(
      spaceId,
      ownerUserId,
    );
    if (
      !ownerLedger ||
      ownerLedger.status !== "active" ||
      !ownerLedger.roles.includes("owner")
    ) {
      const stamp = now().toISOString();
      await deps.membershipLedgerStore.upsert({
        id: ownerLedger?.id ?? `membership_${spaceId}_${ownerUserId}`,
        spaceId,
        accountId: ownerUserId,
        roles: ["owner"],
        status: "active",
        createdAt: ownerLedger?.createdAt ?? stamp,
        updatedAt: stamp,
      });
    }
  };

  return {
    listMembers: (spaceId) => memberships.listSpaceMemberships(spaceId),
    upsertMember: async (input) => {
      // Self-bootstrap so the REAL domain path matches what the route layer
      // (which gates on the namespace owner) already assumes.
      await ensureBootstrap(input.spaceId);
      const result = await memberships.upsertSpaceMembership({
        spaceId: input.spaceId,
        accountId: input.accountId,
        ...(input.roles ? { roles: input.roles } : {}),
        ...(input.status ? { status: input.status } : {}),
        actor: {
          actorAccountId: input.actor.actorAccountId,
          roles: [...input.actor.roles],
          requestId: input.actor.requestId,
        },
      });
      if (!result.ok) {
        // The control routes enforce the role/last-owner gate before calling, so
        // a domain error here is a defense-in-depth backstop. Re-throw with the
        // domain `code` so the surface can map it (permission_denied etc.).
        throw Object.assign(new Error(result.error.message), {
          code: result.error.code,
        });
      }
      return result.value;
    },
  };
}
