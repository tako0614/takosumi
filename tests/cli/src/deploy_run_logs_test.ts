import { expect, test } from "bun:test";
import { main } from "../../../cli/src/main.ts";

async function withRunLogsResponse(
  payload: unknown,
  run: (requests: Request[], stdout: string[], stderr: string[]) => Promise<void>,
): Promise<void> {
  const requests: Request[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.TAKOSUMI_DEPLOY_CONTROL_URL;
  process.env.TAKOSUMI_DEPLOY_CONTROL_URL = "https://deploy.example.test/";
  globalThis.fetch = ((input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(Response.json(payload));
  }) as typeof fetch;

  try {
    await run(requests, stdout, stderr);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.TAKOSUMI_DEPLOY_CONTROL_URL;
    else process.env.TAKOSUMI_DEPLOY_CONTROL_URL = originalUrl;
  }
}

test("logs renders accepted credential refresh and mint timing without unknown data", async () => {
  await withRunLogsResponse(
    {
      diagnostics: [{ severity: "warning", message: "Existing diagnostic" }],
      auditEvents: [
        {
          id: "audit-1",
          type: "credential.refresh.accepted",
          at: 1780000000000,
          actor: "operator",
          message: "do not print this message",
          data: {
            sequence: 2,
            connectionId: "conn_gcp",
            provider: "google",
            previousExpiresAt: "2026-05-28T12:00:00.000Z",
            expiresAt: "2026-05-28T12:30:00.000Z",
            acknowledgedAt: "2026-05-28T12:20:00.000Z",
            token: "secret-refresh-token",
            env: { GOOGLE_CREDENTIALS: "secret-env-value" },
            state: { value: "sensitive-state" },
            output: { value: "sensitive-output" },
            nested: { secret: "nested-secret" },
          },
        },
      ],
      credentialMints: [
        {
          connectionId: "conn_gcp",
          provider: "google",
          createdAt: "2026-05-28T11:00:00.000Z",
          temporary: true,
          ttlEnforced: true,
          expiresAt: "2026-05-28T12:00:00.000Z",
          ttlSeconds: 3600,
          issuer: "https://issuer.example.test/",
          token: "mint-token-secret",
          metadata: { secret: "mint-nested-secret" },
        },
      ],
    },
    async (requests, stdout, stderr) => {
      const code = await main(["logs", "run/with space", "--token", "run-token"], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });

      expect(code).toEqual(0);
      expect(stderr).toEqual([]);
      expect(stdout[0]).toEqual("[warning] Existing diagnostic");
      expect(stdout.some((line) => line.includes("credential.refresh.accepted"))).toEqual(true);
      expect(stdout.some((line) => line.includes("sequence=2"))).toEqual(true);
      expect(stdout.some((line) => line.includes("provider=google"))).toEqual(true);
      expect(stdout.some((line) => line.includes("[credential mint]"))).toEqual(true);
      expect(stdout.some((line) => line.includes("ttl=3600s"))).toEqual(true);
      expect(stdout.join("\n")).not.toMatch(
        /do not print|secret-refresh-token|secret-env-value|sensitive-state|sensitive-output|nested-secret|mint-token-secret|mint-nested-secret|issuer\.example/,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toEqual("GET");
      expect(requests[0]?.headers.get("authorization")).toEqual("Bearer run-token");
      expect(requests[0]?.url).toEqual(
        "https://deploy.example.test/api/v1/runs/run%2Fwith%20space/logs",
      );
    },
  );
});

test("logs describes empty legacy evidence and rejects malformed responses", async () => {
  await withRunLogsResponse(
    { diagnostics: [], auditEvents: [] },
    async (_requests, stdout, stderr) => {
      const code = await main(["logs", "run_empty"], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });
      expect(code).toEqual(0);
      expect(stdout).toEqual([
        "No diagnostics or audit events were returned; credential-mint evidence is not included in this response.",
      ]);
      expect(stderr).toEqual([]);
    },
  );

  await withRunLogsResponse(
    { diagnostics: [], auditEvents: [], credentialMints: [] },
    async (_requests, stdout, stderr) => {
      const code = await main(["logs", "run_empty_complete"], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });
      expect(code).toEqual(0);
      expect(stdout).toEqual(["No run log entries are available."]);
      expect(stderr).toEqual([]);
    },
  );

  await withRunLogsResponse(
    { diagnostics: [], auditEvents: [], credentialMints: null },
    async (_requests, stdout, stderr) => {
      const code = await main(["logs", "run_malformed"], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });
      expect(code).toEqual(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual(["deploy-control returned an invalid run logs response"]);
    },
  );
});

test("logs renders the current public response without credential mint evidence", async () => {
  await withRunLogsResponse(
    {
      diagnostics: [],
      auditEvents: [
        {
          id: "audit-main-contract",
          type: "run.approved",
          at: 1780000000000,
        },
      ],
    },
    async (_requests, stdout, stderr) => {
      const code = await main(["logs", "run_main_contract"], {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });

      expect(code).toEqual(0);
      expect(stdout).toHaveLength(1);
      expect(stdout[0]).toContain("[event] run.approved at ");
      expect(stdout.join("\n")).not.toContain("credential mint");
      expect(stdout.join("\n")).not.toContain("no credential mints");
      expect(stderr).toEqual([]);
    },
  );
});
