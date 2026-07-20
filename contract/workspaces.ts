/**
 * Workspace owner-namespace contract.
 *
 * A Workspace is the owner namespace directly under which Projects and Capsules
 * live — close to a source-forge or organization namespace (`@acme`,
 * `@company`). It holds members,
 * sources, connections, projects, capsules, the dependency graph, policy,
 * activity, and optional billing. A personal Workspace is auto-created on first
 * login.
 *
 */

import type { PolicyConfig } from "./install-configs.ts";
import type { BillingSettings } from "./billing.ts";
import type { Page, PageParams } from "./pagination.ts";

export type WorkspaceType = "personal" | "organization";

/** Roles granted by the canonical Workspace membership ledger. */
export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

/** Lifecycle of a canonical Workspace membership row. */
export type WorkspaceMemberStatus = "active" | "invited" | "suspended";

/**
 * One account's membership in a Workspace.
 *
 * This is part of the same control-plane ledger as {@link Workspace}; it is
 * not a second membership-domain projection. A soft removal sets `status` to
 * `suspended` so authorization history remains auditable.
 */
export interface WorkspaceMember {
  readonly id: string;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly roles: readonly WorkspaceRole[];
  readonly status: WorkspaceMemberStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Allowed shape of a Workspace `handle` (the user-chosen, globally unique
 * identifier shown as `@handle`). Lowercase letter/digit start, then 1-38 more
 * letters/digits/hyphens — 2-39 chars total, no uppercase, underscore, or
 * leading hyphen. This is the single source of truth: the control-plane service
 * (`core/domains/workspaces`) validates against this same pattern, and the
 * dashboard create form mirrors it for inline feedback.
 */
export const WORKSPACE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

/** True when `handle` is a syntactically valid Workspace handle. */
export function isValidWorkspaceHandle(handle: string): boolean {
  return WORKSPACE_HANDLE_PATTERN.test(handle);
}

/**
 * Derive a candidate Workspace handle from free-form text (typically the
 * display name) so the create form can pre-fill an editable id. Lowercases,
 * turns runs of unsupported characters into single hyphens, trims leading /
 * trailing hyphens, and clips to the 39-char maximum.
 *
 * Returns `""` when nothing usable remains (e.g. a purely non-ASCII name like
 * "新プロジェクト") — the caller then leaves the id field for manual entry
 * rather than inventing a meaningless handle. A single leftover character is
 * also rejected because the pattern requires at least two.
 */
export function slugifyWorkspaceHandle(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : "";
}

export interface Workspace {
  readonly id: string;
  /** Unique handle without the `@` prefix (`acme` for `@acme`). */
  readonly handle: string;
  readonly displayName: string;
  readonly type: WorkspaceType;
  readonly ownerUserId: string;
  /** Provider-neutral OSS accounting mode; commercial attachment is host-owned. */
  readonly billingSettings?: BillingSettings;
  /**
   * Soft-archive marker. Archived Workspaces remain addressable by id for audit,
   * restores, and direct admin reads, but default Workspace lists hide them so
   * old smoke/test Workspaces do not pollute the normal product switcher.
   */
  readonly archivedAt?: string;
  /**
   * Optional Workspace-wide policy defaults / ceilings. The deploy-control plane
   * composes this with the target InstallConfig policy at plan-completion time;
   * per-run ledgers store only the resulting decision.
   */
  readonly policy?: PolicyConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Stable account-scoped Workspace list orders used by the account/dashboard
 * composition. `created_asc` preserves the public `/api/v1/workspaces` order;
 * `updated_desc` preserves the dashboard switcher's most-recent-first order.
 */
export type AccountWorkspaceListOrder = "created_asc" | "updated_desc";

/**
 * Internal account-scoped Workspace page request. The cursor is the same
 * opaque keyset token as other control-plane lists; callers must not decode it.
 */
export interface AccountWorkspaceListParams extends PageParams {
  readonly includeArchived?: boolean;
  readonly order?: AccountWorkspaceListOrder;
  /** Opt in to the extra exact `count(*)`; hot interactive reads omit it. */
  readonly includeTotal?: boolean;
}

/**
 * Bounded canonical-membership Workspace page. When `includeTotal=true`,
 * `total` counts all matching active memberships before cursor filtering.
 * Hot interactive reads omit it and use the `limit + 1` probe instead.
 */
export interface AccountWorkspacePage extends Page<Workspace> {
  readonly total?: number;
}

/**
 * Bounded session API envelope returned by `GET /api/v1/workspaces`.
 * `limit` defaults to 100 and is hard-capped at 100; clients follow the opaque
 * `nextCursor` when they genuinely need every authorized Workspace.
 *
 * `selectedWorkspaceId` pins an authorized current Workspace into the first
 * page even when it is outside the requested keyset window. In that case the
 * response contains at most `limit + 1` rows and `pinnedWorkspaceId` names the
 * extra row; the opaque `nextCursor` still describes only the ordered page.
 */
export interface PublicWorkspaceListPage {
  readonly workspaces: readonly Workspace[];
  /** Present only when the caller explicitly requests `includeTotal=true`. */
  readonly total?: number;
  readonly returned: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
  readonly pinnedWorkspaceId?: string;
}

/** Capsule full name (`@workspace/name`) helper shape. */
export interface CapsuleFullName {
  readonly workspaceHandle: string;
  readonly capsuleName: string;
}

/** Formats `@workspace/name`. */
export function formatCapsuleFullName(name: CapsuleFullName): string {
  return `@${name.workspaceHandle}/${name.capsuleName}`;
}
