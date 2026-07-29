import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";

import type { StateVersion } from "@takosumi/internal/deploy-control-api";
import type {
  D1PreparedStatement,
  D1Result,
} from "../../../worker/src/bindings.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(20_000);

const TS = "2026-07-29T00:00:00.000Z";

class ObservedStateVersionLookupD1 extends SqliteFakeD1 {
  readonly stateVersionLookupBoundCounts: number[] = [];

  resetStateVersionLookups(): void {
    this.stateVersionLookupBoundCounts.length = 0;
  }

  override prepare(query: string): D1PreparedStatement {
    const statement = super.prepare(query);
    if (
      !/from "state_versions" where "state_versions"\."id" in \(/i.test(query)
    ) {
      return statement;
    }
    return new ObservedStateVersionLookupStatement(statement, (boundCount) => {
      this.stateVersionLookupBoundCounts.push(boundCount);
    });
  }
}

class ObservedStateVersionLookupStatement implements D1PreparedStatement {
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

function stateVersion(index: number): StateVersion {
  const suffix = String(index).padStart(3, "0");
  return {
    id: `state_lookup_${suffix}`,
    workspaceId: "workspace_state_lookup",
    capsuleId: "capsule_state_lookup",
    environment: "production",
    generation: index + 1,
    stateRef: `state/state_lookup_${suffix}`,
    digest: `sha256:state-lookup-${suffix}`,
    createdByRunId: `run_state_lookup_${suffix}`,
    createdAt: TS,
  };
}

const db = new ObservedStateVersionLookupD1();
const store = new CloudflareD1OpenTofuControlStore(db);
const seeded = Array.from({ length: 500 }, (_, index) => stateVersion(index));

beforeAll(async () => {
  for (const item of seeded) await store.putStateVersion(item);
  db.resetStateVersionLookups();
});

test("D1 StateVersion bulk lookup returns 1/100/500 rows in bounded query counts", async () => {
  for (const [count, expectedChunks] of [
    [1, [1]],
    [100, [90, 10]],
    [500, [90, 90, 90, 90, 90, 50]],
  ] as const) {
    db.resetStateVersionLookups();
    const ids = seeded.slice(0, count).map((item) => item.id);
    expect(
      (await store.getStateVersionsByIds(ids)).map((item) => item.id),
    ).toEqual(ids);
    expect(db.stateVersionLookupBoundCounts).toEqual(expectedChunks);
    expect(db.stateVersionLookupBoundCounts).toHaveLength(
      Math.ceil(count / 90),
    );
    expect(
      db.stateVersionLookupBoundCounts.every((boundCount) => boundCount <= 90),
    ).toBe(true);
  }
});

test("D1 StateVersion bulk lookup deduplicates query values but preserves caller order", async () => {
  db.resetStateVersionLookups();
  const requestedIds = [
    seeded[499]!.id,
    seeded[0]!.id,
    seeded[499]!.id,
    "state_lookup_missing",
    seeded[99]!.id,
    seeded[0]!.id,
  ];
  expect(
    (await store.getStateVersionsByIds(requestedIds)).map((item) => item.id),
  ).toEqual([
    seeded[499]!.id,
    seeded[0]!.id,
    seeded[499]!.id,
    seeded[99]!.id,
    seeded[0]!.id,
  ]);
  expect(db.stateVersionLookupBoundCounts).toEqual([4]);
});
