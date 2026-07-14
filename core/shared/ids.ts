/**
 * Resource Shape keeps the released `Space` scope noun. This alias belongs to
 * that API only; source-and-run Workspace membership has its own contract.
 *
 * Currently a plain string; kept as a named alias so that future branding
 * (opaque or nominal types) can be introduced from a single location.
 * Domain modules re-export this type to preserve the existing public surface.
 */
export type SpaceId = string;
