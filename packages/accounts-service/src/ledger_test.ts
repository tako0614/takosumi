import { expect, test } from "bun:test";
import { assertEquals, assertThrows } from "../../../test/assert.ts";
import {
  assertValidAppBindingRecord,
  assertValidAppGrantRecord,
  buildInstallationEvent,
  transitionAppInstallationStatus,
  validateAppBindingDeclaration,
  verifyInstallationEventHashChain,
} from "./ledger.ts";

test("validateAppBindingDeclaration accepts the v1 binding kinds", () => {
  const declarations = {
    auth: {
      type: "identity.oidc@v1",
      required: true,
      redirectPaths: ["/auth/oidc/callback"],
    },
    db: {
      type: "database.postgres@v1",
      required: true,
      plan: "small",
      version: "16",
      extensions: ["pgvector"],
    },
    blob: {
      type: "object-store.s3-compatible@v1",
      required: true,
      plan: "standard",
      encryption: { mode: "sse-s3" },
    },
    domain: {
      type: "domain.http@v1",
      required: true,
      hostname: "auto",
    },
    bootstrap: {
      type: "install-launch-token@v1",
      required: true,
      consumePath: "/_takosumi/launch",
      maxLifetimeSeconds: 300,
    },
  };

  for (const [name, declaration] of Object.entries(declarations)) {
    expect(validateAppBindingDeclaration(name, declaration)).toEqual([]);
  }
});

test("validateAppBindingDeclaration rejects unknown kinds and unsafe fields", () => {
  expect(validateAppBindingDeclaration("Auth", {
      type: "identity.oauth@v1",
      required: true,
    }).map((issue) => issue.path)).toEqual(["bindings.Auth", "bindings.Auth.type"]);
  expect(validateAppBindingDeclaration("db", {
      type: "database.postgres@v1",
      required: true,
      plan: "small",
      extensions: ["unsafe_extension"],
    }).map((issue) => issue.path)).toEqual(["bindings.db.extensions"]);
  expect(validateAppBindingDeclaration("blob", {
      type: "object-store.s3-compatible@v1",
      required: true,
      plan: "standard",
      encryption: { mode: "sse-kms" },
    }).map((issue) => issue.path)).toEqual(["bindings.blob.encryption.kmsKeyRef"]);
  expect(validateAppBindingDeclaration("service", {
      type: "service.import@v1",
      required: true,
      service: "identity.primary.oidc",
      endpointRoles: ["OIDC"],
      refreshPolicy: { kind: "ttl", ttl: "five-minutes" },
    }).map((issue) => issue.path)).toEqual(["bindings.service.type"]);
});

test("assertValidAppBindingRecord keeps config and secret references only", () => {
  assertValidAppBindingRecord({
    bindingId: "bind_auth",
    installationId: "inst_1",
    name: "auth",
    kind: "identity.oidc@v1",
    configRef: "config://inst_1/auth",
    secretRefs: ["secret://inst_1/auth/client-secret"],
    createdAt: 1000,
    updatedAt: 1000,
  });

  assertThrows(
    () =>
      assertValidAppBindingRecord({
        bindingId: "bind_bootstrap",
        installationId: "inst_1",
        name: "bootstrap",
        kind: "install-launch-token@v1",
        configRef: "config://inst_1/bootstrap",
        secretRefs: ["secret://must-not-exist"],
        createdAt: 1000,
        updatedAt: 1000,
      }),
    TypeError,
    "must not store secret references",
  );

  assertThrows(
    () => {
      const record = {
        bindingId: "bind_account_auth",
        installationId: "inst_1",
        name: "account-auth",
        kind: "service.import@v1",
        configRef: "config://inst_1/account-auth",
        secretRefs: [],
        createdAt: 1000,
        updatedAt: 1000,
      } as never;
      assertValidAppBindingRecord(record);
    },
    TypeError,
    "binding kind is not in catalog v1",
  );
});

test("assertValidAppGrantRecord keeps capabilities in the v1 catalog", () => {
  assertValidAppGrantRecord({
    grantId: "grant_files",
    installationId: "inst_1",
    capability: "files:read",
    scope: { pathPrefix: "documents/" },
    grantedAt: 1000,
  });

  assertThrows(
    () =>
      assertValidAppGrantRecord({
        grantId: "grant_unsafe",
        installationId: "inst_1",
        capability: "unsafe.scope",
        scope: {},
        grantedAt: 1000,
      } as never),
    TypeError,
    "grant capability is not in catalog v1",
  );
});

test("transitionAppInstallationStatus enforces the ledger state machine", () => {
  const installation = {
    installationId: "inst_1",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos",
    sourceRef: "v1.2.3",
    sourceCommit: "abc123",
    planSnapshotDigest: "sha256:app",
    artifactDigest: "sha256:compiled",
    mode: "shared-cell" as const,
    status: "installing" as const,
    createdBySubject: "tsub_owner" as const,
    createdAt: 1000,
    updatedAt: 1000,
  };

  expect(transitionAppInstallationStatus(installation, "ready", 2000).status).toEqual("ready");
  assertThrows(
    () => transitionAppInstallationStatus(installation, "exported", 2000),
    TypeError,
    "installing -> exported",
  );
});

test("InstallationEvent hash chain detects tampering", async () => {
  const first = await buildInstallationEvent({
    eventId: "evt_1",
    installationId: "inst_1",
    eventType: "installation.created",
    payload: { status: "installing" },
    createdAt: 1000,
  });
  const second = await buildInstallationEvent({
    eventId: "evt_2",
    installationId: "inst_1",
    eventType: "installation.status_changed",
    payload: { from: "installing", to: "ready" },
    previousEventHash: first.eventHash,
    createdAt: 2000,
  });

  expect(await verifyInstallationEventHashChain([first, second])).toEqual(true);
  expect(await verifyInstallationEventHashChain([
      first,
      { ...second, payload: { from: "installing", to: "failed" } },
    ])).toEqual(false);
});
