import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { installRunNeedsFallbackRead } from "../../../../../dashboard/src/views/new/install-run-polling.ts";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../dashboard/src/views/new/InstallExecution.tsx",
  ),
  "utf8",
);
const root = resolve(import.meta.dir, "../../../../../");
const noop = () => null;

// InstallExecution is a Solid TSX view. Mock its render-only dependencies so
// this test can exercise the exported read seam in Bun's server test runtime.
mock.module("react/jsx-dev-runtime", () => ({
  Fragment: noop,
  jsxDEV: () => null,
}));
mock.module("lucide-solid", () => ({
  AlertCircle: noop,
  CheckCircle2: noop,
  ExternalLink: noop,
  Loader2: noop,
  ShieldAlert: noop,
  X: noop,
  XCircle: noop,
}));
mock.module(resolve(root, "dashboard/src/components/ui/index.ts"), () => ({
  Badge: noop,
  Button: noop,
  Checkbox: noop,
  Spinner: noop,
}));

const { boundedRead } = await import(
  resolve(root, "dashboard/src/views/new/InstallExecution.tsx")
);

test("waiting approval exposes technical run details before approval", () => {
  const waitingApproval = source.match(
    /<Show when=\{current\(\)\.status === "waiting_approval"\}>([\s\S]*?)<\/Show>/,
  )?.[1];

  expect(waitingApproval).toBeDefined();
  expect(waitingApproval).toContain(
    "href={`/runs/${encodeURIComponent(current().id)}`}",
  );
  expect(waitingApproval).toContain('t("installStore.runDetails")');
  expect(waitingApproval).toContain('t("installStore.approve")');
});

test("post-apply readiness fails closed when activity cannot be read", () => {
  expect(source).toContain("listActivity(workspaceId, 100)");
  expect(source).not.toContain("listActivity(workspaceId, 100).catch(() => [])");
  expect(source).toContain('setError(t("installStore.readinessFailed"))');
  expect(source).toContain("if (readiness.error) {");
  expect(source).toContain("return;");
  expect(source).toContain("!readiness.error");
  expect(source).toContain("readinessFailure()");
  expect(source).toContain("onClick={retryReadiness}");
  expect(source).toContain('t("common.details")');
  expect(source).toContain('t("installStore.runDetails")');
});

test("boundedRead retries transient failures and stops at its finite budget", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await boundedRead(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient");
      return "ready";
    },
    {
      attempts: 3,
      delayMs: 17,
      sleep: async (delay) => delays.push(delay),
    },
  );

  expect(result).toBe("ready");
  expect(attempts).toBe(3);
  expect(delays).toEqual([17, 17]);

  let permanentAttempts = 0;
  await expect(
    boundedRead(
      async () => {
        permanentAttempts += 1;
        throw new Error("permanent");
      },
      { attempts: 3, delayMs: 0, sleep: async () => undefined },
    ),
  ).rejects.toThrow("permanent");
  expect(permanentAttempts).toBe(3);
});

test("install Run keeps a fallback read until a terminal state", () => {
  expect(installRunNeedsFallbackRead(undefined)).toBe(true);
  expect(installRunNeedsFallbackRead({ status: "queued" } as never)).toBe(
    true,
  );
  expect(installRunNeedsFallbackRead({ status: "running" } as never)).toBe(
    true,
  );
  for (const status of [
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ] as const) {
    expect(installRunNeedsFallbackRead({ status } as never)).toBe(false);
  }
});
