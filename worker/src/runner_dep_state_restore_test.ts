import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "bun:test";
import { handleDepStateRestoreRequest } from "../../runner/entrypoint.ts";

// The runner workspace deps dir is a SIBLING of the per-run root so the restored
// producer state survives the plan/apply workspace prep (which wipes root). The
// handler writes <RUN_ROOT>/<safeRunId>-deps/<name>.tfstate read-only (0444).
const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";
const RUN_ID = "dep-restore-test-run";
const DEPS_DIR = join(RUN_ROOT, `${RUN_ID}-deps`);

beforeEach(async () => {
  await rm(DEPS_DIR, { recursive: true, force: true });
  await mkdir(RUN_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(DEPS_DIR, { recursive: true, force: true });
});

const PRODUCER_STATE = new TextEncoder().encode(
  '{"version":4,"serial":3,"outputs":{"base_domain":{"value":"x"}}}',
);

test("handleDepStateRestoreRequest writes the producer state read-only (0444) into the deps dir", async () => {
  const response = await handleDepStateRestoreRequest(
    RUN_ID,
    "producer",
    new Request("https://runner/runs/x/deps/producer/restore", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: PRODUCER_STATE,
    }),
  );
  assert.equal(response.status, 200);

  const target = join(DEPS_DIR, "producer.tfstate");
  // The bytes are exactly the producer state the DO handed over.
  assert.deepEqual(new Uint8Array(await readFile(target)), PRODUCER_STATE);
  // The file is read-only: mode bits masked to 0o777 are 0o444.
  const info = await stat(target);
  assert.equal(info.mode & 0o777, 0o444);
});

test("handleDepStateRestoreRequest re-restores over a prior read-only file", async () => {
  await handleDepStateRestoreRequest(
    RUN_ID,
    "producer",
    new Request("https://runner/x", { method: "PUT", body: PRODUCER_STATE }),
  );
  const second = new TextEncoder().encode('{"version":4,"serial":4}');
  const response = await handleDepStateRestoreRequest(
    RUN_ID,
    "producer",
    new Request("https://runner/x", { method: "PUT", body: second }),
  );
  assert.equal(response.status, 200);
  const target = join(DEPS_DIR, "producer.tfstate");
  assert.deepEqual(new Uint8Array(await readFile(target)), second);
});

test("handleDepStateRestoreRequest path-jails a traversal dep name", async () => {
  const response = await handleDepStateRestoreRequest(
    RUN_ID,
    "../escape",
    new Request("https://runner/x", { method: "PUT", body: PRODUCER_STATE }),
  );
  // The unsafe name is rejected; no file escapes the deps dir.
  assert.equal(response.status, 500);
  await assert.rejects(() => stat(join(RUN_ROOT, "escape.tfstate")));
});

test("handleDepStateRestoreRequest rejects a non-PUT method", async () => {
  const response = await handleDepStateRestoreRequest(
    RUN_ID,
    "producer",
    new Request("https://runner/x", { method: "GET" }),
  );
  assert.equal(response.status, 405);
});
