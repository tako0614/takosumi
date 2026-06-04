/**
 * Constant-time comparison helpers shared across the service's bearer / token /
 * signature checks. Previously every route (deployControl, artifact, metrics) and
 * the routing-token service hand-rolled its own copy, and the copies disagreed
 * on whether they short-circuited on a length mismatch (which leaks the secret
 * length via timing).
 *
 * The length-safe implementation now lives once on the contract surface
 * (`contract/internal-crypto.ts`) so the service, the internal signed-channel
 * envelopes, and the in-process Takos worker all share a single source of truth.
 * Both functions fold the length difference into the accumulator and iterate
 * over the longer operand so the comparison time does not vary with where the
 * first differing byte is, nor with whether the lengths match.
 */

export {
  constantTimeEqualsBytes,
  constantTimeEqualsString,
} from "../../contract/internal-crypto.ts";
