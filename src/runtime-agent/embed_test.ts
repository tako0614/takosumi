import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  LIFECYCLE_AGENT_TOKEN_ENV,
  LIFECYCLE_AGENT_URL_ENV,
  LIFECYCLE_HEALTH_PATH,
} from "takosumi-contract/reference/runtime-agent-lifecycle";
import { startEmbeddedAgent } from "./embed.ts";

test("startEmbeddedAgent serves /v1/health and exports env", async () => {
  const prevUrl = process.env[LIFECYCLE_AGENT_URL_ENV];
  const prevToken = process.env[LIFECYCLE_AGENT_TOKEN_ENV];
  delete process.env[LIFECYCLE_AGENT_URL_ENV];
  delete process.env[LIFECYCLE_AGENT_TOKEN_ENV];
  const handle = startEmbeddedAgent({ port: 0, env: {} });
  try {
    const res = await fetch(`${handle.url}${LIFECYCLE_HEALTH_PATH}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.connectors, "number");
    assert.equal(process.env[LIFECYCLE_AGENT_URL_ENV], handle.url);
    assert.equal(process.env[LIFECYCLE_AGENT_TOKEN_ENV], handle.token);
    assert.equal(handle.token.length, 64);
  } finally {
    await handle.shutdown();
    if (prevUrl) process.env[LIFECYCLE_AGENT_URL_ENV] = prevUrl;
    else delete process.env[LIFECYCLE_AGENT_URL_ENV];
    if (prevToken) process.env[LIFECYCLE_AGENT_TOKEN_ENV] = prevToken;
    else delete process.env[LIFECYCLE_AGENT_TOKEN_ENV];
  }
});

test("startEmbeddedAgent does not export env when exportToProcessEnv=false", async () => {
  const prevUrl = process.env[LIFECYCLE_AGENT_URL_ENV];
  delete process.env[LIFECYCLE_AGENT_URL_ENV];
  const handle = startEmbeddedAgent({
    port: 0,
    env: {},
    exportToProcessEnv: false,
  });
  try {
    assert.equal(process.env[LIFECYCLE_AGENT_URL_ENV], undefined);
  } finally {
    await handle.shutdown();
    if (prevUrl) process.env[LIFECYCLE_AGENT_URL_ENV] = prevUrl;
  }
});
