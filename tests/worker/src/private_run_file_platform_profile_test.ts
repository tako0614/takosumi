import { expect, test } from "bun:test";
import { privateRunFilesCompositionFor } from "../../../worker/src/private_run_files_composition.ts";
import { composeTakoserverHostedWorkerEnv } from "../../../deploy/platform/takoserver_hosted_worker.ts";
import { deployControlServiceOptions } from "../../../worker/src/deploy_control_seam.ts";

const CONFIG = { endpoint: "https://private.example/internal/private-run-files/v1", prefix: "isolated/private-files", maxBytes: 16 * 1024 * 1024 };

test("a frozen accessor object cannot impersonate the immutable host projection", () => {
  let endpoint = CONFIG.endpoint;
  const supplied = Object.freeze({ get endpoint() { return endpoint; }, prefix: CONFIG.prefix, maxBytes: CONFIG.maxBytes });
  expect(() => privateRunFilesCompositionFor({ TAKOSUMI_PRIVATE_RUN_FILES: JSON.stringify(CONFIG), TAKOSUMI_PRIVATE_RUN_FILES_COMPOSITION: supplied })).toThrow();
  endpoint = "https://changed.example/internal/private-run-files/v1";
});

test("absent descriptor remains off and cannot be enabled on an already pinned environment", () => {
  const env: { TAKOSUMI_PRIVATE_RUN_FILES?: string } = {};
  expect(privateRunFilesCompositionFor(env)).toBeUndefined();
  expect(composeTakoserverHostedWorkerEnv(env as never).TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([]);
  expect(deployControlServiceOptions(env as never).privateRunFiles).toBeUndefined();
  env.TAKOSUMI_PRIVATE_RUN_FILES = JSON.stringify(CONFIG);
  expect(() => composeTakoserverHostedWorkerEnv(env as never)).toThrow("cannot change");
});

test("request and pre-constructor RunOwner host composition share one immutable configuration without creating slots", () => {
  const env = { TAKOSUMI_PRIVATE_RUN_FILES: JSON.stringify(CONFIG) };
  const snapshot = privateRunFilesCompositionFor(env);
  const requestEnv = composeTakoserverHostedWorkerEnv(env as never);
  const ownerEnv = composeTakoserverHostedWorkerEnv(env as never);
  expect(requestEnv).toBe(ownerEnv);
  expect(requestEnv.TAKOSUMI_PRIVATE_RUN_FILES_COMPOSITION).toBe(snapshot);
  expect(deployControlServiceOptions(requestEnv).privateRunFiles).toBe(snapshot);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.getOwnPropertyDescriptor(requestEnv, "TAKOSUMI_PRIVATE_RUN_FILES_COMPOSITION")).toMatchObject({ enumerable: true, configurable: false, writable: false });
  expect(requestEnv.TAKOSUMI_INSTALL_CONFIG_COMPOSITION).toEqual([]);
  env.TAKOSUMI_PRIVATE_RUN_FILES = JSON.stringify({ ...CONFIG, prefix: "another/prefix" });
  expect(() => privateRunFilesCompositionFor(env)).toThrow("cannot change");
  expect(snapshot?.prefix).toBe(CONFIG.prefix);
});

for (const value of [
  "", "null", "[]", "true", "{}", "{", " ".repeat(4097),
  JSON.stringify({ ...CONFIG, ready: true }),
  JSON.stringify({ ...CONFIG, slots: [{ slot: "untrusted" }] }),
  JSON.stringify({ ...CONFIG, grant: "untrusted" }),
  JSON.stringify({ ...CONFIG, endpoint: "/internal/private-run-files/v1" }),
  JSON.stringify({ ...CONFIG, endpoint: "http://127.0.0.1/internal/private-run-files/v1" }),
  JSON.stringify({ ...CONFIG, endpoint: "https://user:password@private.example/internal/private-run-files/v1" }),
  JSON.stringify({ ...CONFIG, endpoint: "https://private.example/internal/private-run-files/v1?" }),
  JSON.stringify({ ...CONFIG, endpoint: "https://private.example/internal/private-run-files/v1#" }),
  JSON.stringify({ ...CONFIG, endpoint: "https://private.example/internal/private-run-files/v1/read" }),
  JSON.stringify({ ...CONFIG, endpoint: "https://PRIVATE.example/internal/private-run-files/v1" }),
  ...[0, -1, 1.5, 16 * 1024 * 1024 - 1, "16777216"].map(maxBytes => JSON.stringify({ ...CONFIG, maxBytes })),
  ...["", "/prefix", "prefix/", "a//b", "a/../b", "a/./b", "a\\b", "a/%2e%2e/b", "x".repeat(241)].map(prefix => JSON.stringify({ ...CONFIG, prefix })),
]) {
  test("closed private-file configuration rejects malformed authority-free descriptor " + value.slice(0, 28), () => {
    expect(() => privateRunFilesCompositionFor({ TAKOSUMI_PRIVATE_RUN_FILES: value })).toThrow("composition is invalid");
  });
}
