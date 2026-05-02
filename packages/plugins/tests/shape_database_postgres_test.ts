import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract";
import { DatabasePostgresShape } from "../src/shapes/database-postgres.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  DatabasePostgresShape.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  DatabasePostgresShape.validateOutputs(value, issues);
  return issues;
}

Deno.test("DatabasePostgres shape exposes id and version", () => {
  assert.equal(DatabasePostgresShape.id, "database-postgres");
  assert.equal(DatabasePostgresShape.version, "v1");
});

Deno.test("DatabasePostgres output fields produce a portable connection contract", () => {
  assert.deepEqual([...DatabasePostgresShape.outputFields], [
    "host",
    "port",
    "database",
    "username",
    "passwordSecretRef",
    "connectionString",
  ]);
});

Deno.test("DatabasePostgres validateSpec accepts minimal spec", () => {
  assert.deepEqual(specIssues({ version: "16", size: "small" }), []);
});

Deno.test("DatabasePostgres validateSpec rejects unknown size", () => {
  const issues = specIssues({ version: "16", size: "huge" });
  assert.ok(issues.some((i) => i.path === "$.size"));
});

Deno.test("DatabasePostgres validateSpec rejects missing version", () => {
  const issues = specIssues({ size: "small" });
  assert.ok(issues.some((i) => i.path === "$.version"));
});

Deno.test("DatabasePostgres validateSpec accepts full spec", () => {
  assert.deepEqual(
    specIssues({
      version: "16",
      size: "medium",
      storage: { sizeGiB: 100, type: "ssd" },
      backups: { enabled: true, retentionDays: 14 },
      highAvailability: true,
      extensions: ["pgcrypto", "uuid-ossp"],
    }),
    [],
  );
});

Deno.test("DatabasePostgres validateSpec rejects invalid storage size", () => {
  const issues = specIssues({
    version: "16",
    size: "small",
    storage: { sizeGiB: 0 },
  });
  assert.ok(issues.some((i) => i.path === "$.storage.sizeGiB"));
});

Deno.test("DatabasePostgres validateSpec rejects bad backups.enabled type", () => {
  const issues = specIssues({
    version: "16",
    size: "small",
    backups: { enabled: "yes" },
  });
  assert.ok(issues.some((i) => i.path === "$.backups.enabled"));
});

Deno.test("DatabasePostgres validateOutputs requires connection string", () => {
  const issues = outputIssues({
    host: "db.example.com",
    port: 5432,
    database: "app",
    username: "app",
    passwordSecretRef: "secret://db/password",
  });
  assert.ok(issues.some((i) => i.path === "$.connectionString"));
});

Deno.test("DatabasePostgres validateOutputs accepts complete outputs", () => {
  assert.deepEqual(
    outputIssues({
      host: "db.example.com",
      port: 5432,
      database: "app",
      username: "app",
      passwordSecretRef: "secret://db/password",
      connectionString: "postgresql://app@db.example.com:5432/app",
    }),
    [],
  );
});
