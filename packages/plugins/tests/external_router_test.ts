import assert from "node:assert/strict";
import {
  type ExternalRouterCondition,
  ExternalRouterController,
  type ExternalRouterHealthProbe,
  type ExternalRouterReloader,
} from "../src/providers/external/mod.ts";

class FakeReloader implements ExternalRouterReloader {
  calls = 0;
  failures: number[] = [];
  reload(input: { kind: string; path?: string }) {
    this.calls += 1;
    if (this.failures.length > 0) {
      const code = this.failures.shift()!;
      throw new Error(`reload fail ${code}`);
    }
    return Promise.resolve({
      reloadedAt: "2026-04-30T00:00:00.000Z",
      revision: `${input.kind}-${this.calls}`,
    });
  }
}

class FakeProbe implements ExternalRouterHealthProbe {
  results = new Map<string, { ok: boolean; status?: number }>();
  probe(input: { target: string }) {
    const r = this.results.get(input.target) ?? { ok: true, status: 200 };
    return Promise.resolve({ ...r, latencyMs: 1 });
  }
}

Deno.test("external router validate accepts well-formed Caddy config", () => {
  const controller = new ExternalRouterController();
  const issues = controller.validate(
    "example.test {\n  reverse_proxy upstream:8080\n}\n",
    "caddy",
  );
  assert.deepEqual(issues, []);
});

Deno.test("external router validate rejects empty config", () => {
  const controller = new ExternalRouterController();
  const issues = controller.validate("   \n", "caddy");
  assert.ok(issues.includes("config-empty"));
});

Deno.test("external router reload retries transient reload failures", async () => {
  const reloader = new FakeReloader();
  reloader.failures.push(500);
  const controller = new ExternalRouterController({
    reloader,
    sleep: () => Promise.resolve(),
    initialBackoffMs: 1,
  });
  const result = await controller.reload("traefik");
  assert.ok(result);
  assert.equal(reloader.calls, 2);
});

Deno.test("external router probeTargets aggregates health condition", async () => {
  const probe = new FakeProbe();
  probe.results.set("svc-a", { ok: true, status: 200 });
  probe.results.set("svc-b", { ok: false, status: 502 });
  const conditions: ExternalRouterCondition[] = [];
  const controller = new ExternalRouterController({
    healthProbe: probe,
    conditionSink: (c) => conditions.push(c),
  });
  const results = await controller.probeTargets([
    { target: "svc-a" },
    { target: "svc-b" },
  ]);
  assert.equal(results.length, 2);
  assert.ok(
    conditions.some((c) => c.type === "RouterHealthy" && c.status === "false"),
  );
});

Deno.test("external router reload returns undefined when no reloader configured", async () => {
  const controller = new ExternalRouterController();
  const result = await controller.reload("caddy");
  assert.equal(result, undefined);
});
