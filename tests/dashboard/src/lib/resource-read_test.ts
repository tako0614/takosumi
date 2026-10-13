import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Resource } from "solid-js";
import { latestOrUndefined } from "../../../../dashboard/src/lib/resource-read.ts";

const root = resolve(import.meta.dir, "../../../../dashboard/src");

/** A resource double with solid-js 1.9's `latest` semantics. */
function fakeResource<T>(state: {
  readonly value?: T;
  readonly error?: unknown;
  readonly loading?: boolean;
}): Resource<T> {
  const read = () => {
    if (state.error !== undefined && !state.loading) throw state.error;
    return state.value as T;
  };
  return Object.defineProperties(read, {
    error: { get: () => state.error },
    loading: { get: () => state.loading ?? false },
    latest: { get: read },
  }) as unknown as Resource<T>;
}

describe("latestOrUndefined", () => {
  test("returns the value of a healthy resource", () => {
    expect(latestOrUndefined(fakeResource({ value: 7 }))).toBe(7);
  });

  test("returns undefined where `latest` would throw", () => {
    const failed = fakeResource<number>({
      value: 7,
      error: new Error("503"),
    });
    expect(() => failed.latest).toThrow("503");
    expect(latestOrUndefined(failed)).toBeUndefined();
  });

  test("keeps the previous value while a refetch after a failure is in flight", () => {
    expect(
      latestOrUndefined(
        fakeResource({ value: 7, error: new Error("503"), loading: true }),
      ),
    ).toBe(7);
  });
});

describe("page errors stay inside the page", () => {
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");

  test("the shell wraps page content, not the chrome, in the route boundary", () => {
    const shell = read("views/account/components/shell/AppShell.tsx");
    const content = shell.slice(shell.indexOf("<RouteErrorBoundary>"));
    expect(content.indexOf("{props.children}")).toBeGreaterThan(0);
    expect(content.indexOf("</RouteErrorBoundary>")).toBeGreaterThan(
      content.indexOf("{props.children}"),
    );
    expect(shell.indexOf("<Sidebar />")).toBeLessThan(
      shell.indexOf("<RouteErrorBoundary>"),
    );
  });

  test("unexpected install readiness errors still fail closed by throwing", () => {
    // The readiness fetcher maps ordinary read failures to `read-failed` and
    // rethrows anything else ON PURPOSE, so the page boundary — not an Open
    // link — handles an install whose readiness is unknown.
    const source = read("views/new/InstallExecution.tsx");
    expect(source).toContain("const result = readiness.latest;");
    expect(source).not.toContain("latestOrUndefined(readiness)");
  });

  test("the route boundary resets on navigation and recovers stale chunks", () => {
    const boundary = read("components/RouteErrorBoundary.tsx");
    expect(boundary).toContain("() => location.pathname");
    expect(boundary).toContain("props.reset()");
    expect(boundary).toContain("reloadForStaleAsset(props.error)");
    expect(read("components/ErrorBoundary.tsx")).toContain(
      "reloadForStaleAsset(err)",
    );
  });

  test("detail views read their primary resource without throwing", () => {
    // Raw `x.latest` / `x()` reads rethrow once a load fails, which skipped
    // these views' own not-found / retry states. Mentions inside backticks
    // (comments) are fine.
    const cases: readonly (readonly [string, string])[] = [
      ["views/runs/RunView.tsx", "run"],
      ["views/runs/RunView.tsx", "capsule"],
      ["views/new/InstallExecution.tsx", "run"],
      ["views/apps/WorkloadDetailView.tsx", "capsule"],
      ["views/graph/GraphView.tsx", "graph"],
    ];
    for (const [file, name] of cases) {
      const source = read(file);
      const raw = new RegExp(`(?<![\\w.\`])${name}(?:\\.latest\\b|\\(\\))(?!\`)`, "u");
      expect({ file, name, raw: raw.exec(source)?.[0] }).toEqual({
        file,
        name,
        raw: undefined,
      });
    }
  });
});
