import assert from "node:assert/strict";
import {
  type SelfHostedRouterCondition,
  SelfHostedRouterController,
  type SelfHostedRouterHealthProbe,
  type SelfHostedRouterReloader,
} from "../src/providers/selfhosted/mod.ts";

class FakeReloader implements SelfHostedRouterReloader {
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

class FakeProbe implements SelfHostedRouterHealthProbe {
  results = new Map<string, { ok: boolean; status?: number }>();
  probe(input: { target: string }) {
    const r = this.results.get(input.target) ?? { ok: true, status: 200 };
    return Promise.resolve({ ...r, latencyMs: 1 });
  }
}

Deno.test("selfhosted router validate accepts well-formed Caddy config", () => {
  const controller = new SelfHostedRouterController();
  const issues = controller.validate(
    "example.test {\n  reverse_proxy upstream:8080\n}\n",
    "caddy",
  );
  assert.deepEqual(issues, []);
});

Deno.test("selfhosted router validate rejects empty config", () => {
  const controller = new SelfHostedRouterController();
  const issues = controller.validate("   \n", "caddy");
  assert.ok(issues.includes("config-empty"));
});

Deno.test("selfhosted router reload retries transient reload failures", async () => {
  const reloader = new FakeReloader();
  reloader.failures.push(500);
  const controller = new SelfHostedRouterController({
    reloader,
    sleep: () => Promise.resolve(),
    initialBackoffMs: 1,
  });
  const result = await controller.reload("traefik");
  assert.ok(result);
  assert.equal(reloader.calls, 2);
});

Deno.test("selfhosted router probeTargets aggregates health condition", async () => {
  const probe = new FakeProbe();
  probe.results.set("svc-a", { ok: true, status: 200 });
  probe.results.set("svc-b", { ok: false, status: 502 });
  const conditions: SelfHostedRouterCondition[] = [];
  const controller = new SelfHostedRouterController({
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

Deno.test("selfhosted router reload returns undefined when no reloader configured", async () => {
  const controller = new SelfHostedRouterController();
  const result = await controller.reload("caddy");
  assert.equal(result, undefined);
});
