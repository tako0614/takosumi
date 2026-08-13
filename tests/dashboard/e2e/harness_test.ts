import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveExternalStorageState } from "../../../scripts/dashboard-browser-e2e/live-inputs.ts";
import {
  requiresLiveWorkerVersionHeader,
  shouldRecordControlPlaneMutation,
  shouldRecordRequestFailure,
  shouldRecordResponseFailure,
  workerVersionHeaderFailure,
} from "./traffic-policy.ts";
import {
  assertExpectedResponseUrl,
  assertExpectedRouteStatus,
  assertExpectedWorkerVersionId,
} from "../../../scripts/dashboard-browser-e2e/version-contract.ts";

const repoRoot = resolve(import.meta.dir, "../../..");

test("live storage state rejects repository-local files and symlink escapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "takosumi-dashboard-e2e-"));
  const repositoryDirectory = await mkdtemp(
    join(repoRoot, ".tmp-dashboard-e2e-"),
  );
  try {
    const externalState = join(directory, "storage-state.json");
    await writeFile(externalState, "{}\n", "utf8");
    expect(resolveExternalStorageState(repoRoot, externalState)).toBe(
      realpathSync(externalState),
    );

    const repositoryState = join(repositoryDirectory, "storage-state.json");
    await writeFile(repositoryState, "{}\n", "utf8");
    expect(() => resolveExternalStorageState(repoRoot, repositoryState)).toThrow(
      /outside the repository\/worktree/u,
    );

    const symlinkState = join(directory, "symlink-state.json");
    await symlink(externalState, symlinkState);
    expect(() => resolveExternalStorageState(repoRoot, symlinkState)).toThrow(
      /must not use a symlink/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(repositoryDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test("traffic policy keeps live optional probes but fails required routes and 5xx", () => {
  const origin = "https://dashboard.example.test";
  expect(
    shouldRecordResponseFailure(
      "portable",
      origin,
      `${origin}/api/v1/unexpected-404`,
      404,
    ),
  ).toBe(true);
  expect(
    shouldRecordResponseFailure(
      "portable",
      origin,
      `${origin}/assets/missing.js`,
      404,
    ),
  ).toBe(true);
  expect(
    shouldRecordResponseFailure(
      "live",
      origin,
      `${origin}/v1/optional-capability-probe`,
      404,
    ),
  ).toBe(false);
  expect(
    shouldRecordResponseFailure(
      "live",
      origin,
      `${origin}/api/v1/dashboard/bootstrap?includeWorkspaces=true`,
      404,
    ),
  ).toBe(true);
  expect(
    shouldRecordResponseFailure(
      "live",
      origin,
      "https://api.example.test/health",
      503,
    ),
  ).toBe(true);
  expect(shouldRecordRequestFailure("https://dashboard.example.test/api")).toBe(
    true,
  );
  expect(shouldRecordRequestFailure("data:text/plain,offline")).toBe(false);
});

test("mutation telemetry ignores external RUM and non-control-plane requests", () => {
  const origin = "https://app-staging.takosumi.com";
  expect(
    shouldRecordControlPlaneMutation(
      "live",
      origin,
      `${origin}/cdn-cgi/rum`,
      "POST",
    ),
  ).toBe(false);
  expect(
    shouldRecordControlPlaneMutation(
      "live",
      origin,
      `${origin}/api/v1/sources`,
      "POST",
    ),
  ).toBe(true);
  expect(
    shouldRecordControlPlaneMutation(
      "live",
      origin,
      `${origin}/v1/optional-mutation-probe`,
      "DELETE",
    ),
  ).toBe(true);
  expect(
    shouldRecordControlPlaneMutation(
      "live",
      origin,
      "https://store.example.test/api/v1/sources",
      "POST",
    ),
  ).toBe(false);
  expect(
    shouldRecordControlPlaneMutation(
      "live",
      origin,
      `${origin}/api/v1/workspaces`,
      "GET",
    ),
  ).toBe(false);
});

test("live Version evidence rejects missing and substituted response headers", () => {
  const origin = "https://app-staging.takosumi.com";
  const expected = "00000000-0000-4000-8000-000000000001";
  expect(
    requiresLiveWorkerVersionHeader(
      "live",
      origin,
      `${origin}/api/v1/workspaces`,
      "xhr",
    ),
  ).toBe(true);
  expect(
    workerVersionHeaderFailure({
      mode: "live",
      origin,
      url: `${origin}/api/v1/workspaces`,
      resourceType: "xhr",
      expectedWorkerVersionId: expected,
      observedWorkerVersionId: null,
    }),
  ).toMatch(/observed <missing>/u);
  expect(
    workerVersionHeaderFailure({
      mode: "live",
      origin,
      url: `${origin}/api/v1/workspaces`,
      resourceType: "xhr",
      expectedWorkerVersionId: expected,
      observedWorkerVersionId: "00000000-0000-4000-8000-000000000002",
    }),
  ).toMatch(/expected x-takosumi-version-id/u);
  expect(
    workerVersionHeaderFailure({
      mode: "live",
      origin,
      url: `${origin}/assets/app-12345678.js`,
      resourceType: "script",
      expectedWorkerVersionId: expected,
      observedWorkerVersionId: null,
    }),
  ).toBeUndefined();
});

test("live OIDC and unauthenticated API evidence rejects the wrong response", () => {
  expect(() =>
    assertExpectedResponseUrl({
      route: "/.well-known/openid-configuration",
      expectedUrl:
        "https://app-staging.takosumi.com/.well-known/openid-configuration",
      observedUrl: "https://app-staging.takosumi.com/sign-in",
    }),
  ).toThrow(/expected response URL .*observed .*sign-in/u);
  expect(() =>
    assertExpectedRouteStatus({
      route: "/.well-known/openid-configuration",
      expectedStatus: 200,
      observedStatus: 401,
    }),
  ).toThrow(/expected status 200, observed 401/u);
  expect(() =>
    assertExpectedRouteStatus({
      route: "/api/v1/dashboard/bootstrap",
      expectedStatus: 401,
      observedStatus: 200,
    }),
  ).toThrow(/expected status 401, observed 200/u);
  expect(() =>
    assertExpectedWorkerVersionId({
      route: "/oauth/jwks",
      expectedWorkerVersionId: "00000000-0000-4000-8000-000000000001",
      observedWorkerVersionId: null,
    }),
  ).toThrow(/missing x-takosumi-version-id/u);
});
