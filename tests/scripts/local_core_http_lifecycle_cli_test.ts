import { expect, test } from "bun:test";

import {
  boundedRunnerFetch,
  cleanupOwnedContainer,
  parseProofArgs,
  requireLocalDockerEndpoint,
  runAndEmitAfterCleanup,
} from "../proofs/local-core-http-lifecycle.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;

test("manual Core HTTP proof requires an explicit immutable local image ID", () => {
  expect(parseProofArgs(["--image", IMAGE])).toEqual({ image: IMAGE });
  expect(parseProofArgs(["--", "--image", IMAGE])).toEqual({ image: IMAGE });
  for (const args of [
    [],
    ["--image", "latest"],
    ["--image", "registry.example.test/runner@" + IMAGE],
    ["--image", `sha256:${"A".repeat(64)}`],
    ["--image", IMAGE, "--pull"],
  ]) {
    expect(() => parseProofArgs(args)).toThrow("usage");
  }
});

test("manual Core HTTP proof fails closed for remote or overridden Docker endpoints", () => {
  expect(requireLocalDockerEndpoint("unix:///var/run/docker.sock", {})).toBe(
    "/var/run/docker.sock",
  );
  for (const host of [
    "tcp://localhost:2375",
    "ssh://operator.example.test",
    "unix://relative.sock",
    "unix:///tmp/../remote.sock",
  ]) {
    expect(() => requireLocalDockerEndpoint(host, {})).toThrow();
  }
  expect(() => requireLocalDockerEndpoint("unix:///var/run/docker.sock", {
    DOCKER_HOST: "tcp://remote.example.test:2376",
  })).toThrow("overrides");
  expect(() => requireLocalDockerEndpoint("unix:///var/run/docker.sock", {
    DOCKER_CONTEXT: "remote",
  })).toThrow("overrides");
});

test("lost Docker acknowledgement cannot remove a foreign container with the chosen name", async () => {
  const id = "b".repeat(64);
  const calls: string[][] = [];
  const runDocker = async (...args: string[]) => {
    calls.push(args);
    if (args[0] === "ps") return id.slice(0, 12);
    if (args[0] === "container" && args[1] === "inspect") {
      return `${id}|${IMAGE}|another-owner|/proof-name`;
    }
    throw new Error("unexpected Docker mutation");
  };
  await expect(cleanupOwnedContainer({
    name: "proof-name",
    ownerNonce: "our-owner",
    image: IMAGE,
    runDocker,
  })).rejects.toThrow("another owner");
  expect(calls.some(([action]) => action === "rm")).toBe(false);
});

test("owned Docker cleanup removes the inspected immutable ID and confirms absence", async () => {
  const id = "c".repeat(64);
  const nonce = "our-owner";
  let present = true;
  const removals: string[] = [];
  const runDocker = async (...args: string[]) => {
    if (args[0] === "ps") return present ? id.slice(0, 12) : "";
    if (args[0] === "container" && args[1] === "inspect") {
      return `${id}|${IMAGE}|${nonce}|/proof-name`;
    }
    if (args[0] === "rm") {
      removals.push(args[2] ?? "");
      present = false;
      return id;
    }
    throw new Error("unexpected Docker command");
  };
  await cleanupOwnedContainer({ name: "proof-name", ownerNonce: nonce, image: IMAGE, runDocker });
  expect(removals).toEqual([id]);
  expect(present).toBe(false);
});

test("cleanup failure suppresses the passing marker", async () => {
  const markers: string[] = [];
  await expect(runAndEmitAfterCleanup(
    async () => ({ status: "passed" }),
    async () => { throw new Error("cleanup failed"); },
    (result) => { markers.push(result.status); },
  )).rejects.toThrow("cleanup failed");
  expect(markers).toEqual([]);
});

test("proof-scoped runner HTTP caps reject oversized artifacts and streamed replies", async () => {
  const artifactFetch = boundedRunnerFetch(
    "http://127.0.0.1:4321",
    (async () => new Response(new Uint8Array(), {
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch,
  );
  await expect(artifactFetch("http://127.0.0.1:4321/runs/r/artifacts/tfstate"))
    .rejects.toThrow("byte cap");

  const streamedFetch = boundedRunnerFetch(
    "http://127.0.0.1:4321",
    (async () => new Response(new Uint8Array(256 * 1024 + 1))) as unknown as typeof fetch,
  );
  await expect(streamedFetch("http://127.0.0.1:4321/runs/r"))
    .rejects.toThrow("byte cap");
  await expect(streamedFetch("http://external.example.test/runs/r"))
    .rejects.toThrow("external HTTP destination");
});
