/**
 * D1 accepts at most 100 bound parameters per statement. Keep ten parameters
 * available for fixed predicates so data-sized `IN (...)` clauses remain safe
 * when their surrounding query grows.
 */
export const D1_SAFE_IN_QUERY_VALUE_LIMIT = 90;

/** Split caller-sized `IN (...)` values into statements that stay below D1's limit. */
export function chunkD1InQueryValues<T>(
  values: readonly T[],
): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += D1_SAFE_IN_QUERY_VALUE_LIMIT
  ) {
    chunks.push(values.slice(offset, offset + D1_SAFE_IN_QUERY_VALUE_LIMIT));
  }
  return chunks;
}
