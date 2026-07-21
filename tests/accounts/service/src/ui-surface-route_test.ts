import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import { createInMemoryInterfaceStores } from "../../../../core/domains/interfaces/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const ORIGIN = "https://app.takosumi.test";
const SUBJECT = "user_test";

function seedSession(store: InMemoryAccountsStore): string {
  const now = Date.now();
  store.saveAccount({
    subject: SUBJECT,
    email: "user_test@example.test",
    displayName: "UI Surface User",
    createdAt: now,
    updatedAt: now,
  });
  const sessionId = "sess_ui_surface_route";
  store.saveAccountSession({
    sessionId,
    subject: SUBJECT,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`;
}

test("Workspace UI surface projection uses the exact session Principal and fails closed", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const primary = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_ui_surface",
    capsuleId: "cap_ui_primary",
    sourceId: "src_ui_primary",
    snapshotId: "snap_ui_primary",
    installConfigId: "cfg_ui_primary",
  });
  await deployStore.patchCapsule(primary.capsule.id, { status: "active" });
  const staleCapsule = {
    ...primary.capsule,
    id: "cap_ui_stale",
    name: "stale-ui",
    slug: "stale-ui",
    status: "active" as const,
  };
  await deployStore.putCapsule(staleCapsule);

  const foreign = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_ui_foreign",
    capsuleId: "cap_ui_foreign",
    sourceId: "src_ui_foreign",
    snapshotId: "snap_ui_foreign",
    installConfigId: "cfg_ui_foreign",
  });
  await deployStore.putWorkspace({
    ...foreign.workspace,
    ownerUserId: "other_subject",
  });
  await deployStore.patchCapsule(foreign.capsule.id, { status: "active" });

  const interfaceStores = createInMemoryInterfaceStores();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    interfaceStores,
  });
  const createSurface = (name: string, capsuleId = primary.capsule.id) =>
    operations.interfaces.create({
      workspaceId: primary.workspace.id,
      name,
      ownerRef: { kind: "Capsule" as const, id: capsuleId },
      spec: {
        type: "interface.ui.surface",
        version: "1",
        document: { launcher: true, display: { title: name } },
        inputs: {
          url: {
            source: "literal" as const,
            value: `https://${name}.example.test/app`,
          },
        },
        access: { visibility: "workspace" as const },
      },
    });

  const allowed = await createSurface("allowed");
  await operations.interfaces.createBinding(allowed.metadata.id, {
    subjectRef: { kind: "Principal", id: SUBJECT },
    permissions: ["ui.open"],
    delivery: { type: "none" },
  });

  const otherSubject = await createSurface("other-subject");
  await operations.interfaces.createBinding(otherSubject.metadata.id, {
    subjectRef: { kind: "Principal", id: "other_subject" },
    permissions: ["ui.open"],
    delivery: { type: "none" },
  });

  const revoked = await createSurface("revoked");
  const revokedBinding = await operations.interfaces.createBinding(
    revoked.metadata.id,
    {
      subjectRef: { kind: "Principal", id: SUBJECT },
      permissions: ["ui.open"],
      delivery: { type: "none" },
    },
  );
  await operations.interfaces.revokeBinding(
    revoked.metadata.id,
    revokedBinding.metadata.id,
  );

  const stale = await createSurface("stale", staleCapsule.id);
  await operations.interfaces.createBinding(stale.metadata.id, {
    subjectRef: { kind: "Principal", id: SUBJECT },
    permissions: ["ui.open"],
    delivery: { type: "none" },
  });
  await deployStore.patchCapsule(staleCapsule.id, { status: "destroyed" });

  const request = new Request(
    `${ORIGIN}/api/v1/workspaces/${primary.workspace.id}/ui-surfaces`,
    { headers: { cookie } },
  );
  const response = await handleControlRoute({
    request,
    url: new URL(request.url),
    store: accountStore,
    operations,
  });

  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  const body = (await response?.json()) as {
    readonly interfaces: readonly {
      readonly metadata: { readonly id: string };
    }[];
  };
  expect(body.interfaces.map((iface) => iface.metadata.id)).toEqual([
    allowed.metadata.id,
  ]);
  expect(
    (await operations.interfaces.get(stale.metadata.id)).status.phase,
  ).toBe("NotReady");

  const capsuleRequest = new Request(
    `${ORIGIN}/api/v1/workspaces/${primary.workspace.id}/ui-surfaces?capsuleId=${primary.capsule.id}`,
    { headers: { cookie } },
  );
  const capsuleResponse = await handleControlRoute({
    request: capsuleRequest,
    url: new URL(capsuleRequest.url),
    store: accountStore,
    operations,
  });
  expect(capsuleResponse?.status).toBe(200);
  expect(
    (
      (await capsuleResponse?.json()) as {
        readonly interfaces: readonly {
          readonly metadata: { readonly id: string };
        }[];
      }
    ).interfaces.map((iface) => iface.metadata.id),
  ).toEqual([allowed.metadata.id]);

  const foreignRequest = new Request(
    `${ORIGIN}/api/v1/workspaces/${foreign.workspace.id}/ui-surfaces`,
    { headers: { cookie } },
  );
  const foreignResponse = await handleControlRoute({
    request: foreignRequest,
    url: new URL(foreignRequest.url),
    store: accountStore,
    operations,
  });
  expect(foreignResponse?.status).toBe(403);
});
