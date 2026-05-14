import assert from "node:assert/strict";
import { createKernelLogger } from "./log.ts";

Deno.test("createKernelLogger emits JSON to stdout for info", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = createKernelLogger({
    format: "json",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  log.info("kernel.boot.starting", { role: "takosumi-api", port: 8788 });

  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1);
  const parsed = JSON.parse(stdout[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "kernel.boot.starting");
  assert.equal(parsed.event, "kernel.boot.starting");
  assert.equal(parsed.service, "takosumi-kernel");
  assert.equal(parsed.role, "takosumi-api");
  assert.equal(parsed.port, 8788);
  assert.equal(parsed.ts, "2026-01-01T00:00:00.000Z");
});

Deno.test("createKernelLogger routes warn / error to stderr", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = createKernelLogger({
    format: "json",
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });

  log.warn("kernel.boot.dev_mode_enabled");
  log.error("kernel.boot.fatal");

  assert.equal(stdout.length, 0);
  assert.equal(stderr.length, 2);
  const warnEntry = JSON.parse(stderr[0]);
  const errorEntry = JSON.parse(stderr[1]);
  assert.equal(warnEntry.level, "warn");
  assert.equal(errorEntry.level, "error");
});

Deno.test("createKernelLogger pretty format embeds event and JSON tail", () => {
  const stdout: string[] = [];
  const log = createKernelLogger({
    format: "pretty",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  });

  log.info("kernel.boot.ready", { listening: 8788 });

  assert.equal(stdout.length, 1);
  assert.match(
    stdout[0],
    /^2026-01-01T00:00:00\.000Z INFO \[takosumi-kernel\] kernel\.boot\.ready \{"listening":8788\}$/,
  );
});

Deno.test("createKernelLogger normalizes Error values into fields", () => {
  const stderr: string[] = [];
  const log = createKernelLogger({
    format: "json",
    stdout: () => {},
    stderr: (line) => stderr.push(line),
  });

  const err = new Error("boom");
  log.error("kernel.boot.heartbeat_write_failed", { error: err });

  const parsed = JSON.parse(stderr[0]);
  assert.equal(typeof parsed.error, "object");
  assert.equal(parsed.error.name, "Error");
  assert.equal(parsed.error.message, "boom");
  assert.equal(typeof parsed.error.stack, "string");
});

Deno.test("createKernelLogger format defaults to pretty for local env", () => {
  const stdout: string[] = [];
  const log = createKernelLogger({
    env: { TAKOSUMI_ENVIRONMENT: "local" },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  log.info("kernel.boot.starting");

  assert.match(stdout[0], /^2026-01-01T/);
  assert.ok(!stdout[0].startsWith("{"));
});

Deno.test("createKernelLogger format defaults to json for production env", () => {
  const stdout: string[] = [];
  const log = createKernelLogger({
    env: { TAKOSUMI_ENVIRONMENT: "production" },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
  });

  log.info("kernel.boot.starting");
  assert.ok(stdout[0].startsWith("{"));
});

Deno.test("createKernelLogger honours TAKOSUMI_LOG_FORMAT override", () => {
  const stdout: string[] = [];
  const log = createKernelLogger({
    env: { TAKOSUMI_ENVIRONMENT: "production", TAKOSUMI_LOG_FORMAT: "pretty" },
    stdout: (line) => stdout.push(line),
    stderr: () => {},
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  log.info("kernel.boot.starting");
  assert.ok(!stdout[0].startsWith("{"));
});
