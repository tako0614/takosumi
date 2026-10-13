import { describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";

// Bun resolves "solid-js" to its inert server build; the last-good accessor is
// about reactive resource state, so run it on the browser build.
const solid = await import(
  resolve(import.meta.dir, "../../../../dashboard/node_modules/solid-js/dist/solid.js")
);
mock.module("solid-js", () => solid);
const { createLastGoodValue } = await import(
  "../../../../dashboard/src/lib/resource-read.ts"
);

type Run = { readonly id: string; readonly status: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("createLastGoodValue", () => {
  test("keeps the last good run of this id when a refetch fails", async () => {
    const pending: ReturnType<typeof deferred<Run>>[] = [];
    await solid.createRoot(async (dispose: () => void) => {
      const [id] = solid.createSignal("run_a");
      const [run, { refetch }] = solid.createResource(id, () => {
        const next = deferred<Run>();
        pending.push(next);
        return next.promise;
      });
      const latest = createLastGoodValue(run, (r: Run) => r.id === id());
      pending[0]!.resolve({ id: "run_a", status: "running" });
      await settle();
      expect(latest()).toEqual({ id: "run_a", status: "running" });

      refetch();
      pending[1]!.reject(new Error("503"));
      await settle();
      expect(run.error).toBeDefined();
      expect(() => run.latest).toThrow("503");
      expect(latest()).toEqual({ id: "run_a", status: "running" });
      dispose();
    });
  });

  test("never shows another id's value, loading or failed", async () => {
    const pending: ReturnType<typeof deferred<Run>>[] = [];
    await solid.createRoot(async (dispose: () => void) => {
      const [id, setId] = solid.createSignal("run_a");
      const [run] = solid.createResource(id, () => {
        const next = deferred<Run>();
        pending.push(next);
        return next.promise;
      });
      const latest = createLastGoodValue(run, (r: Run) => r.id === id());
      pending[0]!.resolve({ id: "run_a", status: "succeeded" });
      await settle();
      expect(latest()?.id).toBe("run_a");

      setId("run_b");
      // `run.latest` still holds run_a while run_b loads.
      expect(run.latest?.id).toBe("run_a");
      expect(latest()).toBeUndefined();

      pending[1]!.reject(new Error("404"));
      await settle();
      expect(latest()).toBeUndefined();
      dispose();
    });
  });
});
