function count(counts, key) {
  return counts[key] ?? 0;
}

export function assertExactRequestDeltas({
  before,
  after,
  managedRoutes,
  expected,
  phase,
}) {
  const managed = new Set(managedRoutes);
  for (const route of Object.keys(expected)) {
    if (!managed.has(route)) {
      throw new Error(`${phase} declared unmanaged expected route ${route}`);
    }
  }
  for (const route of managedRoutes) {
    const wanted = expected[route] ?? 0;
    const actual = count(after, route) - count(before, route);
    if (actual !== wanted) {
      throw new Error(
        `${phase} expected ${route} delta ${wanted}, observed ${actual}`,
      );
    }
  }
}
