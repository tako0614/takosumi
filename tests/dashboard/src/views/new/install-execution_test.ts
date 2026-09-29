import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";
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

test("in-progress install explains Run durability and links to its details", () => {
  const applyProgress = source.match(
    /<Show\s+when=\{\s*current\(\)\.type === "apply"[\s\S]*?\n\s*\}\s*>\s*<div class="iv-status"[\s\S]*?<\/Show>/,
  )?.[0];

  expect(applyProgress).toBeDefined();
  expect(applyProgress).toContain('t("run.summary.queued")');
  expect(applyProgress).toContain('t("run.summary.applying")');
  expect(applyProgress).toContain('t("run.summary.activationPending")');
  expect(applyProgress).toContain('t("run.summary.finishing")');
  expect(applyProgress).toContain(
    "href={`/runs/${encodeURIComponent(current().id)}`}",
  );
  expect(applyProgress).toContain('t("installStore.runDetails")');
  expect(source).toContain("runStatusLabel(current().status)");
  expect(source).toContain('t("installStore.checkingReadinessHint")');
  expect(source).toContain('? t("installStore.runFailed")');
  expect(source).not.toContain("{current().status}</Badge>");

  expect(source).toContain(
    "current().errorCode ?? t(\"installStore.runFailedHint\")",
  );
  expect(source).toContain('<Show when={current().type === "plan"}>');
  expect(source).toContain('<strong>{t("installStore.runFailed")}</strong>');
});

test("install progress copy is user-facing and honest about resume behavior", () => {
  expect(en["installStore.installingHint"]).toBe(
    "Leaving this page won't stop the install. Use Technical details to check progress. This page won't reopen the install automatically.",
  );
  expect(ja["installStore.installingHint"]).toBe(
    "画面を離れてもインストールは続きます。進捗は「技術的な詳細」から確認できます。この追加画面は自動では復元されません。",
  );
  expect(en["installStore.checkingReadinessHint"]).toBe(
    "Deployment is complete. Checking the service state. This page won't reopen the install automatically if you leave.",
  );
  expect(ja["installStore.checkingReadinessHint"]).toBe(
    "デプロイは完了しました。サービスの状態を確認しています。画面を離れると、この追加画面は自動では復元されません。",
  );
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

test("activation failure exposes the existing Apply Run technical details", () => {
  const activationError = source.match(
    /<Show when=\{error\(\) && !readiness\.error\}>([\s\S]*?)<\/Show>/,
  )?.[1];

  expect(activationError).toBeDefined();
  expect(activationError).toContain('readiness.latest === "activation_failed"');
  expect(activationError).toContain(
    "href={`/runs/${encodeURIComponent(currentRun().id)}`}",
  );
  expect(activationError).toContain('t("installStore.runDetails")');
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
