import { expect, test } from "bun:test";
import {
  createServer,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  main,
  probeRequestLatency,
  resolveLatencyProbeOptions,
  runRequestLatencyProbe,
  type RequestLatencyProbeOptions,
  type RequestLatencySample,
  type RequestLatencyProgress,
} from "../../scripts/probe-request-latency.ts";

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (options: RequestLatencyProbeOptions) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveReady) =>
    server.listen(0, "127.0.0.1", resolveReady),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture port missing");
  try {
    await run(
      resolveLatencyProbeOptions({
        environment: "local",
        url: `http://127.0.0.1:${address.port}`,
        samples: "1",
        "timeout-ms": "1000",
        "interval-ms": "0",
      }),
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClosed) =>
      server.close(() => resolveClosed()),
    );
  }
}

test("latency probe correlates only allowlisted metadata and route shape", async () => {
  const secret = "fixture-private-bearer-marker";
  let calls = 0;
  await fixture(
    (request, response) => {
      calls += 1;
      expect(request.method).toBe("GET");
    expect(request.headers["x-takosumi-request-probe-id"]).toMatch(/^[a-f0-9]{16}$/u);
      expect(request.url).toBe("/api/v1/runs/run_private_id_marker");
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      response.writeHead(200, {
        "cf-ray": "0123456789abcdef-NRT",
        "server-timing": `tk_control_auth;dur=2.3, tk_control_init;dur=5000.0, private_marker;dur=2, tk_control_dispatch;dur=1;desc="${secret}"`,
        "set-cookie": `private=${secret}`,
      });
      response.end(`body contains ${secret}`);
    },
    async (options) => {
      const rows: RequestLatencySample[] = [];
      expect(
        await runRequestLatencyProbe(
          {
            ...options,
            samples: 2,
            path: "/api/v1/runs/run_private_id_marker",
          },
          (row) => rows.push(row),
          secret,
        ),
      ).toBe(0);
      expect(calls).toBe(2);
      expect(rows.map((row) => row.sample)).toEqual([1, 2]);
    expect(new Set(rows.map((row) => row.probeId)).size).toBe(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          environment: "local",
          client: "node-http",
          route: "/api/v1/runs/:runId",
          outcome: "response",
          phase: "body",
          status: 200,
          cfRay: "0123456789abcdef-NRT",
          serverTiming: { tk_control_auth: 2.3, tk_control_init: 5000 },
        });
        expect(Date.parse(row.startedAt)).toBeLessThanOrEqual(
          Date.parse(row.finishedAt),
        );
        expect(row.milestones.tcpMs).toBeLessThanOrEqual(
          row.milestones.headersMs!,
        );
        expect(row.milestones.headersMs).toBeLessThanOrEqual(
          row.milestones.bodyMs!,
        );
      }
      const serialized = JSON.stringify(rows);
      for (const marker of [
        secret,
        "run_private_id_marker",
        "private_marker",
        "set-cookie",
        "desc=",
        options.url,
      ]) {
        expect(serialized).not.toContain(marker);
      }
    },
  );
});

test("latency probe bounds never-returning headers and continues exactly the requested samples", async () => {
  let calls = 0;
  const closed: Promise<void>[] = [];
  await fixture(
    (request) => {
      calls += 1;
      closed.push(
        new Promise((resolveClosed) =>
          request.socket.once("close", () => resolveClosed()),
        ),
      );
    },
    async (options) => {
      const rows: RequestLatencySample[] = [];
      const start = performance.now();
      expect(
        await runRequestLatencyProbe(
          { ...options, samples: 2, timeoutMs: 30 },
          (row) => rows.push(row),
        ),
      ).toBe(1);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(calls).toBe(2);
      expect(rows).toHaveLength(2);
      expect(
        rows.every(
          (row) =>
            row.outcome === "timeout" &&
            row.phase === "headers" &&
            row.status === undefined,
        ),
      ).toBe(true);
      // This must close on the client before fixture cleanup closes server sockets.
      await Promise.all(closed);
    },
  );
});

test("latency probe applies its total deadline to an unfinished body after receiving headers", async () => {
  await fixture(
    (_request, response) => {
      response.writeHead(200, { "cf-ray": "0123456789abcdef-NRT" });
      response.write("body-private-marker");
    },
    async (options) => {
      const row = await probeRequestLatency({ ...options, timeoutMs: 30 }, 1);
      expect(row).toMatchObject({
        outcome: "timeout",
        phase: "body",
        status: 200,
        cfRay: "0123456789abcdef-NRT",
      });
      expect(row.milestones.headersMs).toBeDefined();
      expect(row.milestones.bodyMs).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain("body-private-marker");
    },
  );
});

test("latency probe measures delayed headers and body without resetting the deadline", async () => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    await fixture(
      (_request, response) => {
        timers.push(
          setTimeout(() => {
            response.writeHead(200);
            response.write("discarded");
            timers.push(setTimeout(() => response.end("also discarded"), 20));
          }, 20),
        );
      },
      async (options) => {
        const row = await probeRequestLatency(options, 1);
        expect(row.outcome).toBe("response");
        expect(row.milestones.headersMs).toBeGreaterThan(row.milestones.tcpMs!);
        expect(row.milestones.bodyMs).toBeGreaterThan(
          row.milestones.headersMs!,
        );
        expect(row.durationMs).toBeGreaterThanOrEqual(row.milestones.bodyMs!);
        const timedOut = await probeRequestLatency(
          { ...options, timeoutMs: 30 },
          2,
        );
        expect(timedOut).toMatchObject({
          outcome: "timeout",
          phase: "body",
          status: 200,
        });
        expect(timedOut.milestones.bodyMs).toBeUndefined();
      },
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

test("latency probe refuses redirects without contacting the target or serializing Location", async () => {
  let calls = 0;
  await fixture(
    (_request, response) => {
      calls += 1;
      response.writeHead(302, {
        location: "https://app.takosumi.com/?token=redirect-secret-marker",
      });
      response.end();
    },
    async (options) => {
      const row = await probeRequestLatency(options, 1, "fixture-bearer");
      expect(row).toMatchObject({ outcome: "redirect_refused", status: 302 });
      expect(calls).toBe(1);
      expect(JSON.stringify(row)).not.toContain("redirect-secret-marker");
      expect(JSON.stringify(row)).not.toContain("location");
    },
  );
});

test("latency probe stops reading a response at its byte limit", async () => {
  await fixture(
    (_request, response) => {
      response.writeHead(200);
      response.end(Buffer.alloc(1024 * 1024 + 1, 120));
    },
    async (options) => {
      expect((await probeRequestLatency(options, 1)).outcome).toBe(
        "body_limit",
      );
    },
  );
});

test("latency probe uses fixed HTTP and transport outcomes without error or body text", async () => {
  let metadataCalls = 0;
  await fixture(
    (_request, response) => {
      response.writeHead(503, {
        "cf-ray": "private-ray-marker",
        "x-takosumi-version-id":
          ++metadataCalls === 1
            ? "private-version-marker"
            : [
                "12345678-1234-1234-1234-123456789abc",
                "12345678-1234-1234-1234-123456789abc",
              ],
        "server-timing":
          "tk_control_init;dur=Infinity, tk_control_auth;dur=-2, tk_control_dispatch;dur=999999999, tk_accounts_init;dur=3;desc=private-marker",
      });
      response.end("private-error-marker");
    },
    async (options) => {
      for (const sample of [1, 2]) {
        const progress: RequestLatencyProgress[] = [];
        const row = await probeRequestLatency(options, sample, undefined, (event) =>
          progress.push(event),
        );
        expect(row).toMatchObject({
          outcome: "http_error",
          status: 503,
          serverTiming: {},
        });
        expect(row.cfRay).toBeUndefined();
        expect(JSON.stringify(row)).not.toContain("private-");
        expect(progress).toHaveLength(2);
        expect(progress.every((event) => event.versionId === undefined)).toBe(true);
        expect(JSON.stringify(progress)).not.toContain("private-");
      }
    },
  );
  await fixture(
    (request) => request.socket.destroy(),
    async (options) => {
      const row = await probeRequestLatency(options, 1);
      expect(row.outcome).toBe("network_error");
      expect(Object.keys(row)).not.toContain("error");
    },
  );
});

test("latency probe reports truncated bodies and destroys their socket", async () => {
  await fixture(
    (_request, response) => {
      response.writeHead(200, { "content-length": "100000" });
      response.write("tiny");
      response.end();
    },
    async (options) => {
      const row = await probeRequestLatency(options, 1);
      expect(row).toMatchObject({ outcome: "body_error", status: 200 });
    },
  );
});

test("latency probe rejects production, alternate origins, unsafe GET routes and out-of-bounds inputs", () => {
  const args = {
    environment: "staging",
    url: "https://app-staging.takosumi.com",
  };
  expect(resolveLatencyProbeOptions(args)).toMatchObject({
    samples: 12,
    timeoutMs: 130000,
  });
  const invalidArgs: readonly Readonly<Record<string, string>>[] = [
    { environment: "production" },
    { url: "https://app.takosumi.com" },
    { url: "http://app-staging.takosumi.com" },
    { url: "https://app-staging.takosumi.com:444" },
    { url: "https://user:private@ app-staging.takosumi.com" },
    { url: "https://app-staging.takosumi.com/?token=private" },
    { url: "https://app-staging.takosumi.com/#private" },
    { url: "https://app-staging.takosumi.com/api/v1/workspaces" },
    { path: "//app.takosumi.com/api/v1/workspaces" },
    { path: "/logout" },
    { path: "/api/v1/workspaces" },
    { path: "/oauth/authorize" },
    { path: "/api/v1/runs/id?token=private" },
    { path: "/api/v1/runs/id#private" },
    { path: "/api/v1/runs/%2e%2e" },
    { path: "/internal/v1/workspaces" },
    { samples: "71" },
    { samples: "0" },
    { samples: "1.5" },
    { "timeout-ms": "0" },
    { "timeout-ms": "150001" },
    { "interval-ms": "5001" },
  ];
  for (const invalid of invalidArgs)
    expect(() => resolveLatencyProbeOptions({ ...args, ...invalid })).toThrow();
  expect(() =>
    resolveLatencyProbeOptions({
      environment: "local",
      url: "https://app.takosumi.com",
    }),
  ).toThrow();
});

test("latency probe CLI reads a private token file without printing credentials or private identifiers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-latency-private-"));
  await chmod(directory, 0o700);
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "fixture-secret-private-token\n", { mode: 0o600 });
  const originalLog = console.log;
  const originalError = console.error;
  const output: string[] = [];
  console.log = (line) => output.push(String(line));
  console.error = (line) => output.push(String(line));
  try {
    await fixture(
      (request, response) => {
        expect(request.headers.authorization).toBe(
          "Bearer fixture-secret-private-token",
        );
        response.end("body-secret-marker");
      },
      async (options) => {
        const argv = [
          "--environment",
          "local",
          "--url",
          options.url,
          "--samples",
          "1",
          "--token-file",
          tokenFile,
        ];
        expect(await main(argv)).toBe(0);
        await chmod(tokenFile, 0o644);
        expect(await main(argv)).toBe(2);
        expect(await main(["--unknown", "secret-in-argv-marker"])).toBe(2);
        expect(await main(["--samples", "1", "--samples", "2"])).toBe(2);
      },
    );
    const text = output.join("\n");
    for (const secret of [
      tokenFile,
      "fixture-secret-private-token",
      "body-secret-marker",
      "secret-in-argv-marker",
    ]) {
      expect(text).not.toContain(secret);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("latency progress identifies a headers wait before the final sample settles", async () => {
  await fixture(
    () => {},
    async (options) => {
      const progress: RequestLatencyProgress[] = [];
      let settled = false;
      const pending = probeRequestLatency(
        { ...options, timeoutMs: 100 },
        1,
        undefined,
        (row) => progress.push(row),
      ).then((row) => {
        settled = true;
        return row;
      });
      try {
        expect(settled).toBe(false);
        expect(progress.map((row) => row.phase)).toEqual(["headers"]);
        expect(progress[0]).toMatchObject({
          kind: "takosumi.request-latency-progress@v1",
          sample: 1,
          route: "/.well-known/takosumi",
          client: "node-http",
        });
        expect(progress[0].probeId).toMatch(/^[a-f0-9]{16}$/u);
        const final = await pending;
        expect(final).toMatchObject({ outcome: "timeout", phase: "headers" });
        expect(progress).toHaveLength(1);
        expect(progress[0].probeId).toBe(final.probeId);
        expect(progress[0].elapsedMs).toBeLessThanOrEqual(final.durationMs);
      } finally {
        await pending;
      }
    },
  );
});

test("latency progress distinguishes a stalled body while its final result is still pending", async () => {
  const secret = "private-progress-bearer";
  const progress: RequestLatencyProgress[] = [];
  let requestProbe: string | string[] | undefined;
  let bodyObserved!: () => void;
  const bodyReady = new Promise<true>((resolveBody) => {
    bodyObserved = () => resolveBody(true);
  });
  await fixture(
    (request, response) => {
      requestProbe = request.headers["x-takosumi-request-probe-id"];
      expect(request.headers.authorization).toBe("Bearer " + secret);
      response.writeHead(200, {
        "cf-ray": "0123456789abcdef-NRT",
        "x-takosumi-version-id": "12345678-1234-1234-1234-123456789abc",
        "set-cookie": "private=" + secret,
        "server-timing": 'private_metadata;dur=1;desc="' + secret + '"',
      });
      response.write("private-progress-body");
    },
    async (options) => {
      let settled = false;
      const pending = probeRequestLatency(
        { ...options, path: "/api/v1/runs/private_progress_run" },
        1,
        secret,
        (row) => {
          progress.push(row);
          if (row.phase === "body") bodyObserved();
        },
      ).then((row) => {
        settled = true;
        return row;
      });
      try {
        expect(await Promise.race([bodyReady, pending.then(() => false)])).toBe(
          true,
        );
        expect(settled).toBe(false);
        expect(progress.map((row) => row.phase)).toEqual(["headers", "body"]);
        expect(progress[1]).toMatchObject({
          phase: "body",
          status: 200,
          cfRay: "0123456789abcdef-NRT",
          route: "/api/v1/runs/:runId",
          versionId: "12345678-1234-1234-1234-123456789abc",
        });
        if (typeof requestProbe !== "string") {
          throw new Error("fixture probe id missing");
        }
        expect(progress[0].probeId).toBe(requestProbe);
        expect(progress[1].probeId).toBe(requestProbe);
        for (const marker of [
          secret,
          "private_progress_run",
          "private-progress-body",
          "private_metadata",
          "set-cookie",
          options.url,
        ]) {
          expect(JSON.stringify(progress)).not.toContain(marker);
        }
        const final = await pending;
        expect(final).toMatchObject({ outcome: "timeout", phase: "body" });
        expect(final.milestones.bodyMs).toBeUndefined();
        expect(progress).toHaveLength(2);
      } finally {
        await pending;
      }
    },
  );
});

test("latency progress observer failure does not change the request result", async () => {
  await fixture(
    (_request, response) => response.end("discarded"),
    async (options) => {
      let notifications = 0;
      const final = await probeRequestLatency(options, 1, undefined, () => {
        notifications += 1;
        throw new Error("private-observer-error");
      });
      expect(final.outcome).toBe("response");
      expect(notifications).toBe(2);
      expect(JSON.stringify(final)).not.toContain("private-observer-error");
    },
  );
});

test("latency CLI emits progress only on opt-in stderr and preserves final stdout", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (line) => stdout.push(String(line));
  console.error = (line) => stderr.push(String(line));
  try {
    await fixture(
      (_request, response) => response.end("private-cli-body"),
      async (options) => {
        const args = [
          "--environment",
          "local",
          "--url",
          options.url,
          "--samples",
          "1",
        ];
        expect(await main(args)).toBe(0);
        expect(stdout).toHaveLength(1);
        expect(stderr).toHaveLength(0);
        expect(await main(["--progress", ...args])).toBe(0);
        expect(stdout).toHaveLength(2);
        expect(stderr).toHaveLength(2);
        const progress = stderr.map((line) => JSON.parse(line));
        const final = JSON.parse(stdout[1]);
        expect(progress.map((row) => row.phase)).toEqual(["headers", "body"]);
        expect(progress.every((row) => row.probeId === final.probeId)).toBe(true);
        expect(final.kind).toBe("takosumi.request-latency-sample@v1");
        expect(final.outcome).toBe("response");
        expect(stdout.join("\n")).not.toContain("private-cli-body");
        expect(stderr.join("\n")).not.toContain("private-cli-body");
        expect(stderr.join("\n")).not.toContain(options.url);
        expect(await main(["--progress", "--progress", ...args])).toBe(2);
        expect(await main(["--progress", "false", ...args])).toBe(2);
      },
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});
