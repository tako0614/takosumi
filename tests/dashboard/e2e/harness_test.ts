import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveExternalStorageState } from "../../../scripts/dashboard-browser-e2e/live-inputs.ts";
import {
  shouldRecordControlPlaneMutation,
  shouldRecordRequestFailure,
  shouldRecordResponseFailure,
} from "./traffic-policy.ts";

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
      `${origin}/v1/form-availability`,
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
      `${origin}/v1/resources/ObjectBucket/assets`,
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
