import { expect, test } from "bun:test";
import { operatorControlMcpResource } from "../../../deploy/operator-control-mcp.ts";
import { workerInterfaceOAuth2ResourceAuthorizer } from "../../../worker/src/worker_service.ts";

const issuer = "https://app.takosumi.com";

test("built-in Operator MCP authority is resolved before an external authorizer", async () => {
  let externalCalls = 0;
  const authorize = workerInterfaceOAuth2ResourceAuthorizer(
    {
      TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "1",
      TAKOSUMI_ACCOUNTS_ISSUER: issuer,
    },
    {
      getPublicHostReservation: () => Promise.resolve(undefined),
    },
    () => {
      externalCalls += 1;
      return Promise.resolve(false);
    },
  );

  expect(
    await authorize({
      workspaceId: "workspace_a",
      interfaceId: "interface_operator",
      ownerRef: { kind: "Capsule", id: "capsule_operator" },
      resource: operatorControlMcpResource(issuer),
    }),
  ).toBe(true);
  expect(externalCalls).toBe(0);
});

test("Capsule public-host authority precedes external authority and external resources fall through", async () => {
  let externalCalls = 0;
  const authorize = workerInterfaceOAuth2ResourceAuthorizer(
    {
      TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED: "0",
      TAKOSUMI_ACCOUNTS_ISSUER: issuer,
    },
    {
      getPublicHostReservation: (hostname) =>
        Promise.resolve(
          hostname === "capsule.example"
            ? {
                hostname,
                workspaceId: "workspace_a",
                capsuleId: "capsule_a",
                status: "reserved" as const,
                ownerAccountId: "account_a",
                ownership: "workspace" as const,
                createdAt: "2026-08-22T00:00:00.000Z",
                updatedAt: "2026-08-22T00:00:00.000Z",
              }
            : undefined,
        ),
    },
    () => {
      externalCalls += 1;
      return Promise.resolve(true);
    },
  );

  expect(
    await authorize({
      workspaceId: "workspace_a",
      interfaceId: "interface_local",
      ownerRef: { kind: "Capsule", id: "capsule_a" },
      resource: "https://capsule.example/mcp",
    }),
  ).toBe(true);
  expect(externalCalls).toBe(0);

  expect(
    await authorize({
      workspaceId: "workspace_a",
      interfaceId: "interface_external",
      ownerRef: { kind: "Capsule", id: "capsule_a" },
      resource: "https://external.example/mcp",
    }),
  ).toBe(true);
  expect(externalCalls).toBe(1);
});
