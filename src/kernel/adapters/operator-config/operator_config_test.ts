import assert from "node:assert/strict";
import { EnvOperatorConfig, LocalOperatorConfig } from "./mod.ts";

Deno.test("local operator config returns redacted secret refs", async () => {
  const config = new LocalOperatorConfig({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    values: {
      TAKOSUMI_REGION: "local",
      DATABASE_URL: { name: "DATABASE_URL", version: "v1" },
    },
  });

  assert.deepEqual(await config.require("DATABASE_URL"), {
    kind: "secret-ref",
    key: "DATABASE_URL",
    source: "local",
    ref: { name: "DATABASE_URL", version: "v1" },
    redacted: true,
  });
  assert.deepEqual(await config.snapshot(), {
    generatedAt: "2026-04-27T00:00:00.000Z",
    values: [
      {
        kind: "plain",
        key: "TAKOSUMI_REGION",
        source: "local",
        value: "local",
      },
      {
        kind: "secret-ref",
        key: "DATABASE_URL",
        source: "local",
        ref: { name: "DATABASE_URL", version: "v1" },
        redacted: true,
      },
    ],
  });
});

Deno.test("env operator config parses secret ref keys without exposing raw value", async () => {
  const config = new EnvOperatorConfig({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    env: {
      TAKOSUMI_REGION: "local",
      DATABASE_SECRET_REF: "DATABASE_URL@v2",
    },
    include: ["DATABASE_SECRET_REF", "TAKOSUMI_REGION"],
  });

  assert.deepEqual(await config.require("DATABASE_SECRET_REF"), {
    kind: "secret-ref",
    key: "DATABASE_SECRET_REF",
    source: "env",
    ref: { name: "DATABASE_URL", version: "v2" },
    redacted: true,
  });
});
