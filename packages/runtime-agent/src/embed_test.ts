import assert from "node:assert/strict";
import {
  LIFECYCLE_AGENT_TOKEN_ENV,
  LIFECYCLE_AGENT_URL_ENV,
  LIFECYCLE_HEALTH_PATH,
} from "takosumi-contract";
import { startEmbeddedAgent } from "./embed.ts";

Deno.test("startEmbeddedAgent serves /v1/health and exports env", async () => {
  const prevUrl = Deno.env.get(LIFECYCLE_AGENT_URL_ENV);
  const prevToken = Deno.env.get(LIFECYCLE_AGENT_TOKEN_ENV);
  Deno.env.delete(LIFECYCLE_AGENT_URL_ENV);
  Deno.env.delete(LIFECYCLE_AGENT_TOKEN_ENV);
  const handle = startEmbeddedAgent({ port: 0, env: {} });
  try {
    const res = await fetch(`${handle.url}${LIFECYCLE_HEALTH_PATH}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.connectors, "number");
    assert.equal(Deno.env.get(LIFECYCLE_AGENT_URL_ENV), handle.url);
    assert.equal(Deno.env.get(LIFECYCLE_AGENT_TOKEN_ENV), handle.token);
    assert.equal(handle.token.length, 64);
  } finally {
    await handle.shutdown();
    if (prevUrl) Deno.env.set(LIFECYCLE_AGENT_URL_ENV, prevUrl);
    else Deno.env.delete(LIFECYCLE_AGENT_URL_ENV);
    if (prevToken) Deno.env.set(LIFECYCLE_AGENT_TOKEN_ENV, prevToken);
    else Deno.env.delete(LIFECYCLE_AGENT_TOKEN_ENV);
  }
});

Deno.test("startEmbeddedAgent does not export env when exportToProcessEnv=false", async () => {
  const prevUrl = Deno.env.get(LIFECYCLE_AGENT_URL_ENV);
  Deno.env.delete(LIFECYCLE_AGENT_URL_ENV);
  const handle = startEmbeddedAgent({
    port: 0,
    env: {},
    exportToProcessEnv: false,
  });
  try {
    assert.equal(Deno.env.get(LIFECYCLE_AGENT_URL_ENV), undefined);
  } finally {
    await handle.shutdown();
    if (prevUrl) Deno.env.set(LIFECYCLE_AGENT_URL_ENV, prevUrl);
  }
});
