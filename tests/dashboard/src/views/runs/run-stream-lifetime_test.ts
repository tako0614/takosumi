import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Run, openRunStream } from "../../../../../dashboard/src/lib/control-api.ts";
import { isTerminalRunStatus } from "../../../../../dashboard/src/lib/run-logs.ts";

if (Bun.env.TAKOSUMI_RUN_STREAM_TEST_CLIENT !== "1") {
  test("Run detail opens a stream only for a current nonterminal Run", async () => {
    const child = Bun.spawn(
      [process.execPath, "test", "--conditions=browser", import.meta.path],
      {
        env: { ...process.env, TAKOSUMI_RUN_STREAM_TEST_CLIENT: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 4_000,
        killSignal: "SIGKILL",
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited, new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    expect(stderr).toContain("2 pass");
  });
} else {
  const { createEffect, createMemo, createRoot, createSignal, onCleanup } = await import(
    resolve(import.meta.dir, "../../../../../dashboard/node_modules/solid-js/dist/solid.js")
  );
  const source = readFileSync(
    resolve(import.meta.dir, "../../../../../dashboard/src/views/runs/RunView.tsx"), "utf8",
  );
  const start = source.indexOf("  const [sseActive, setSseActive]");
  const end = source.indexOf("  // Fallback poll", start);
  if (start === -1 || end === -1) throw new Error("Run detail stream effect is missing");
  const effect = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  const installStream = new Function(
    "createSignal", "createMemo", "createEffect", "onCleanup", "runId", "readScope",
    "runLatest", "readOptions", "openRunStream", "isTerminalRunStatus",
    "run", "mutateRun", "refetchRun", "refetchLogs", effect + "\nreturn sseActive;",
  );

  class RecordingEventSource extends EventTarget {
    onopen?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: string }) => void;
    closes = 0;
    constructor(readonly url: string, readonly options: { withCredentials: boolean }) {
      super();
      connections.push(this);
    }
    close() { this.closes++; }
    run(row: Pick<Run, "id" | "status">) {
      this.onmessage?.({ data: JSON.stringify({ run: row }) });
    }
  }
  const connections: RecordingEventSource[] = [];
  const run = (id: string, status: Run["status"]) => ({ id, status });

  function withRunDetail(check: (fixture: ReturnType<typeof makeFixture>) => void) {
    const previous = globalThis.EventSource;
    globalThis.EventSource = RecordingEventSource as unknown as typeof EventSource;
    connections.length = 0;
    const fixture = makeFixture();
    try {
      check(fixture);
    } finally {
      fixture.dispose();
      connections.length = 0;
      globalThis.EventSource = previous;
    }
  }

  function makeFixture() {
    return createRoot((dispose: () => void) => {
      const [runId, navigate] = createSignal("historical");
      const [row, publish] = createSignal<ReturnType<typeof run>>();
      const scope = createMemo(() => ({ id: runId() }));
      const latest = () => row()?.id === runId() ? row() : undefined;
      const refetchRun = () => {};
      let logRefreshes = 0;
      let disposed = false;
      onCleanup(() => { disposed = true; });
      const active = installStream(
        createSignal, createMemo, createEffect, onCleanup, runId, scope,
        latest, (owner: { id: string }) => ({
          isCurrent: () => !disposed && scope() === owner,
        }), openRunStream, isTerminalRunStatus, { error: undefined }, publish,
        refetchRun, () => { logRefreshes++; },
      );
      return { active, dispose, latest, navigate, publish, logRefreshes: () => logRefreshes };
    });
  }

  test("a historical Run never opens SSE before or after its initial GET", () => {
    withRunDetail(({ publish, logRefreshes }) => {
      const beforeRead = connections.length;
      publish(run("historical", "succeeded"));
      expect([beforeRead, connections.length]).toEqual([0, 0]);
      expect(logRefreshes()).toBe(0);
    });
  });

  test("one active stream survives Run updates and stops on terminal GET, SSE, or navigation", () => {
    withRunDetail(({ active, latest, navigate, publish, logRefreshes }) => {
      publish(run("historical", "queued"));
      expect(connections.map(({ url }) => url)).toEqual(["/api/v1/runs/historical/stream"]);
      const first = connections[0]!;
      expect(first.options.withCredentials).toBe(true);
      first.onopen?.();
      expect(active()).toBe(true);
      first.run(run("historical", "running"));
      expect(latest()?.status).toBe("running");
      expect(connections).toHaveLength(1);
      expect(logRefreshes()).toBe(1);

      first.onerror?.();
      expect(active()).toBe(false);
      publish(run("historical", "succeeded"));
      expect(first.closes).toBe(1);
      first.onopen?.();
      expect(active()).toBe(false);

      navigate("next");
      expect(connections).toHaveLength(1);
      publish(run("next", "running"));
      const second = connections[1]!;
      second.onopen?.();
      second.run(run("next", "succeeded"));
      expect(second.closes).toBe(1);
      expect(logRefreshes()).toBe(2);
      expect(latest()?.status).toBe("succeeded");

      navigate("leaving");
      publish(run("leaving", "running"));
      const leaving = connections[2]!;
      navigate("replacement");
      publish(run("replacement", "running"));
      const replacement = connections[3]!;
      replacement.onopen?.();
      leaving.onerror?.();
      leaving.run(run("leaving", "failed"));
      expect(leaving.closes).toBe(1);
      expect(active()).toBe(true);
      expect(latest()?.id).toBe("replacement");
      expect(logRefreshes()).toBe(2);
    });
  });
}
