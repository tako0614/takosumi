/**
 * Constant-time comparison helpers shared across the kernel's bearer / token /
 * signature checks. Previously every route (installer, artifact, metrics) and
 * the routing-token service hand-rolled its own copy, and the copies disagreed
 * on whether they short-circuited on a length mismatch (which leaks the secret
 * length via timing). These helpers are the single length-safe source of truth
 * inside the kernel.
 *
 * Both functions fold the length difference into the accumulator and iterate
 * over the longer operand so the comparison time does not vary with where the
 * first differing byte is, nor with whether the lengths match.
 */

/**
 * Constant-time equality over two UTF-8 strings. Operands are encoded as bytes
 * so multi-byte characters in operator tokens are compared end-to-end.
 */
export function constantTimeEqualsString(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  return constantTimeEqualsBytes(
    encoder.encode(left),
    encoder.encode(right),
  );
}

/** Constant-time equality over two byte arrays. */
export function constantTimeEqualsBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
