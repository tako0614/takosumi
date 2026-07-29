import { expect, test } from "bun:test";

import {
  TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT,
  managedRelationalBatchGatewayRequest,
  parseManagedRelationalBatchRequest,
  parseManagedRelationalBatchResponse,
} from "../../contract/managed-relational-runtime.ts";

const authority = {
  workspaceId: "space_app",
  subject: "principal_app",
  resourceId: "tkrn:space_app:RelationalDatabase:database",
  resourceKind: "RelationalDatabase" as const,
  resourceGeneration: 4,
  permissions: ["takosumi.managed-runtime.invoke"],
  interfaceId: "interface_database",
  interfaceBindingId: "binding_database",
  interfaceResolvedRevision: 7,
  audience: "https://app.takosumi.com/v1/cloud/resources",
  capabilityRef: "secret:runtime/database",
};

test("prepared relational batch pins exact Resource and Interface authority", async () => {
  const request = managedRelationalBatchGatewayRequest(authority, {
    idempotencyKey: "relational:test-1",
    statements: [
      {
        sql: "SELECT id, name FROM actors WHERE id = ?1",
        params: ["actor-1"],
        method: "all",
      },
      {
        sql: "UPDATE actors SET name = ? WHERE id = ?",
        params: ["New", "actor-1"],
        method: "run",
      },
    ],
  });
  expect(new URL(request.url).pathname).toEndWith("/relational/v1/batch");
  expect(request.headers.get("x-takosumi-managed-runtime-capability-ref")).toBe(
    "secret:runtime/database",
  );
  expect(await request.json()).toEqual({
    contract: TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT,
    authority: {
      resourceGeneration: 4,
      interfaceId: "interface_database",
      interfaceBindingId: "binding_database",
      interfaceResolvedRevision: 7,
    },
    mode: "ordered_atomic",
    statements: [
      {
        sql: "SELECT id, name FROM actors WHERE id = ?1",
        params: ["actor-1"],
        method: "all",
      },
      {
        sql: "UPDATE actors SET name = ? WHERE id = ?",
        params: ["New", "actor-1"],
        method: "run",
      },
    ],
  });
});

test("ordinary runtime rejects DDL, control SQL, multi-statements, named params, and count drift", () => {
  for (const [sql, params, code] of [
    ["CREATE TABLE nope(id TEXT)", [], "resource_migration"],
    ["PRAGMA table_info(actors)", [], "resource_migration"],
    ["BEGIN", [], "resource_migration"],
    ["SELECT 1; DELETE FROM actors", [], "statement_invalid"],
    ["SELECT * FROM actors WHERE id = :id", ["actor-1"], "statement_invalid"],
    [
      "SELECT * FROM actors WHERE id = ? AND name = ?",
      ["actor-1"],
      "parameter_count",
    ],
  ] as const) {
    expect(() =>
      parseManagedRelationalBatchRequest({
        contract: TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT,
        authority: {
          resourceGeneration: 1,
          interfaceId: "interface",
          interfaceBindingId: "binding",
          interfaceResolvedRevision: 1,
        },
        mode: "ordered_atomic",
        statements: [{ sql, params, method: "all" }],
      }),
    ).toThrow(code);
  }
});

test("response keeps ordered D1-compatible rows and exact usage meta", () => {
  expect(
    parseManagedRelationalBatchResponse(
      {
        contract: TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT,
        results: [
          {
            success: true,
            columns: ["id", "name"],
            rows: [["actor-1", "Name"]],
            meta: {
              changed_db: false,
              changes: 0,
              duration: 0.2,
              last_row_id: 0,
              size_after: 4096,
              rows_read: 1,
              rows_written: 0,
            },
          },
        ],
      },
      1,
    ),
  ).toEqual({
    contract: TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT,
    results: [
      {
        success: true,
        columns: ["id", "name"],
        rows: [["actor-1", "Name"]],
        meta: {
          changed_db: false,
          changes: 0,
          duration: 0.2,
          last_row_id: 0,
          size_after: 4096,
          rows_read: 1,
          rows_written: 0,
        },
      },
    ],
  });
});
