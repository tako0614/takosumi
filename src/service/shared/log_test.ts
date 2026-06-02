import { test } from "bun:test";
import assert from "node:assert/strict";
import { createTakosumiLogger } from "./log.ts";

test("createTakosumiLogger emits JSON to stdout for info", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = createTakosumiLogger({
    format: "json",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  log.info("takosumi.service.boot.starting", {
    role: "takosumi-api",
    port: 8788,
  });

  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1);
  const parsed = JSON.parse(stdout[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "takosumi.service.boot.starting");
  assert.equal(parsed.event, "takosumi.service.boot.starting");
  assert.equal(parsed.service, "takosumi-service");
  assert.equal(parsed.role, "takosumi-api");
  assert.equal(parsed.port, 8788);
  assert.equal(parsed.ts, "2026-01-01T00:00:00.000Z");
});

test("createTakosumiLogger routes warn / error to stderr", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = createTakosumiLogger({
    format: "json",
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  log.warn("takosumi.service.boot.dev_mode_enabled");
  log.error("takosumi.service.boot.fatal");

  assert.equal(stdout.length, 0);
  assert.equal(stderr.length, 2);
  const warnEntry = JSON.parse(stderr[0]);
  const errorEntry = JSON.parse(stderr[1]);
  assert.equal(warnEntry.level, "warn");
  assert.equal(errorEntry.level, "error");
});

test("createTakosumiLogger pretty format embeds event and JSON tail", () => {
  const stdout: string[] = [];
  const log = createTakosumiLogger({
    format: "pretty",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  });

  log.info("takosumi.service.boot.ready", { listening: 8788 });

  assert.equal(stdout.length, 1);
  assert.match(
    stdout[0],
    /^2026-01-01T00:00:00\.000Z INFO \[takosumi-service\] takosumi\.service\.boot\.ready \{"listening":8788\}$/,
  );
});

test("createTakosumiLogger normalizes Error values into fields", () => {
  const stderr: string[] = [];
  const log = createTakosumiLogger({
    format: "json",
    stdout: () => {},
    stderr: (line) => stderr.push(line),
  });

  const err = new Error("boom");
  log.error("takosumi.service.boot.heartbeat_write_failed", { error: err });

  const parsed = JSON.parse(stderr[0]);
  assert.equal(typeof parsed.error, "object");
  assert.equal(parsed.error.name, "Error");
  assert.equal(parsed.error.message, "boom");
  assert.equal(typeof parsed.error.stack, "string");
});

test("createTakosumiLogger format defaults to pretty for local env", () => {
  const stdout: string[] = [];
  const log = createTakosumiLogger({
    env: { TAKOSUMI_ENVIRONMENT: "local" },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  log.info("takosumi.service.boot.starting");

  assert.match(stdout[0], /^2026-01-01T/);
  assert.ok(!stdout[0].startsWith("{"));
});

test("createTakosumiLogger format defaults to json for production env", () => {
  const stdout: string[] = [];
  const log = createTakosumiLogger({
    env: { TAKOSUMI_ENVIRONMENT: "production" },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  });

  log.info("takosumi.service.boot.starting");
  assert.ok(stdout[0].startsWith("{"));
});

test("createTakosumiLogger honours TAKOSUMI_LOG_FORMAT override", () => {
  const stdout: string[] = [];
  const log = createTakosumiLogger({
    env: { TAKOSUMI_ENVIRONMENT: "production", TAKOSUMI_LOG_FORMAT: "pretty" },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  log.info("takosumi.service.boot.starting");
  assert.ok(!stdout[0].startsWith("{"));
});
