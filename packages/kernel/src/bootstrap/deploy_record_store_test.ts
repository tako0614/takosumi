import assert from "node:assert/strict";
import { createInMemoryAppContext } from "../app_context.ts";
import { InMemoryDeployPublicIdempotencyStore } from "../domains/deploy/deploy_public_idempotency_store.ts";
import { InMemoryOperationJournalStore } from "../domains/deploy/operation_journal.ts";
import { InMemoryRevokeDebtStore } from "../domains/deploy/revoke_debt_store.ts";
import { InMemoryTakosumiDeploymentRecordStore } from "../domains/deploy/takosumi_deployment_record_store.ts";
import { buildDeployPublicRouteOptions } from "./deploy_record_store.ts";

Deno.test("buildDeployPublicRouteOptions forwards configured deploy Space id", () => {
  const options = buildDeployPublicRouteOptions({
    context: createInMemoryAppContext(),
    deployToken: "deploy-token",
    deploySpaceId: "space:acme-prod",
    recordStore: new InMemoryTakosumiDeploymentRecordStore(),
    idempotencyStore: new InMemoryDeployPublicIdempotencyStore(),
    operationJournalStore: new InMemoryOperationJournalStore(),
    revokeDebtStore: new InMemoryRevokeDebtStore(),
  });

  assert.equal(options.tenantId, "space:acme-prod");
  assert.equal(options.getDeployToken?.(), "deploy-token");
  assert.ok(options.operationJournalStore);
  assert.ok(options.revokeDebtStore);
});
