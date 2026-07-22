import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";

import type { Workspace } from "takosumi-contract/workspaces";
import type {
  D1PreparedStatement,
  D1Result,
} from "../../../worker/src/bindings.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const TS = "2026-07-22T00:00:00.000Z";

class ObservedWorkspaceLookupD1 extends SqliteFakeD1 {
  readonly workspaceLookupBoundCounts: number[] = [];
  failWorkspaceLookupAt: number | undefined;

  resetWorkspaceLookups(): void {
    this.workspaceLookupBoundCounts.length = 0;
    this.failWorkspaceLookupAt = undefined;
  }

  override prepare(query: string): D1PreparedStatement {
    const statement = super.prepare(query);
    if (!/from "workspaces" where "workspaces"\."id" in \(/i.test(query)) {
      return statement;
    }
    return new ObservedWorkspaceLookupStatement(statement, (boundCount) => {
      this.workspaceLookupBoundCounts.push(boundCount);
      if (
        this.failWorkspaceLookupAt === this.workspaceLookupBoundCounts.length
      ) {
        throw new Error("injected workspace lookup failure");
      }
    });
  }
}

class ObservedWorkspaceLookupStatement implements D1PreparedStatement {
  #boundCount = 0;

  constructor(
    private statement: D1PreparedStatement,
    private readonly beforeExecute: (boundCount: number) => void,
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    this.#boundCount = values.length;
    this.statement = this.statement.bind(...values);
    return this;
  }

  first<T = unknown>(): Promise<T | null> {
    this.beforeExecute(this.#boundCount);
    return this.statement.first<T>();
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    this.beforeExecute(this.#boundCount);
    return this.statement.all<T>();
  }

  raw<T = unknown[]>(): Promise<T[]> {
    this.beforeExecute(this.#boundCount);
    return (
      this.statement as D1PreparedStatement & {
        raw<U = unknown[]>(): Promise<U[]>;
      }
    ).raw<T>();
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    this.beforeExecute(this.#boundCount);
    return this.statement.run<T>();
  }
}

function workspace(index: number): Workspace {
  const suffix = String(index).padStart(3, "0");
  return {
    id: `workspace_lookup_${suffix}`,
    handle: `workspace-lookup-${suffix}`,
    displayName: `Workspace Lookup ${index}`,
    type: "personal",
    ownerUserId: "user_workspace_lookup",
    createdAt: TS,
    updatedAt: TS,
  };
}

const db = new ObservedWorkspaceLookupD1();
const store = new CloudflareD1OpenTofuControlStore(db);
const seeded = Array.from({ length: 205 }, (_, index) => workspace(index));

beforeAll(async () => {
  for (const item of seeded) await store.putWorkspace(item);
  db.resetWorkspaceLookups();
});

test("D1 Workspace lookup stays below the variable limit at 90/91/101/205", async () => {
  for (const [count, expectedChunks] of [
    [90, [90]],
    [91, [90, 1]],
    [101, [90, 11]],
    [205, [90, 90, 25]],
  ] as const) {
    db.resetWorkspaceLookups();
    const ids = seeded.slice(0, count).map((item) => item.id);
    expect(
      (await store.listWorkspacesByIds(ids)).map((item) => item.id),
    ).toEqual(ids);
    expect(db.workspaceLookupBoundCounts).toEqual(expectedChunks);
  }
});

test("D1 Workspace lookup deduplicates query values while preserving caller order", async () => {
  db.resetWorkspaceLookups();
  expect(await store.listWorkspacesByIds([])).toEqual([]);
  expect(db.workspaceLookupBoundCounts).toEqual([]);

  const requestedIds = [
    seeded[100]!.id,
    seeded[0]!.id,
    seeded[100]!.id,
    "workspace_lookup_missing",
    seeded[204]!.id,
    seeded[0]!.id,
  ];
  expect(
    (await store.listWorkspacesByIds(requestedIds)).map((item) => item.id),
  ).toEqual([
    seeded[100]!.id,
    seeded[0]!.id,
    seeded[100]!.id,
    seeded[204]!.id,
    seeded[0]!.id,
  ]);
  expect(db.workspaceLookupBoundCounts).toEqual([4]);
});

test("D1 Workspace lookup propagates a later chunk failure", async () => {
  db.resetWorkspaceLookups();
  db.failWorkspaceLookupAt = 2;
  const ids = seeded.slice(0, 101).map((item) => item.id);

  let failure: unknown;
  try {
    await store.listWorkspacesByIds(ids);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error & { readonly cause?: Error }).cause?.message).toBe(
    "injected workspace lookup failure",
  );
  expect(db.workspaceLookupBoundCounts).toEqual([90, 11]);
});
