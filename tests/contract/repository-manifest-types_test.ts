import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import type {
  RepositoryManifestDocument,
  RepositoryManifestDocumentV1,
  RepositoryManifestDocumentV2,
  RepositoryManifestDocumentV2_1,
  RepositoryManifestDocumentV2_2,
  RepositoryManifestDocumentV2_3,
  RepositoryManifestDocumentV2_4,
  RepositoryRuntimeDelivery,
  RepositoryRuntimeRequirement,
} from "../../contract/repository-manifest.ts";

test("versioned manifest type assertions are checked by the compiler", () => {
  // The production tsconfig intentionally excludes tests. Bun only transpiles
  // this file, so explicitly compile it to enforce every @ts-expect-error and
  // `satisfies` assertion below on each owner test run.
  const root = resolve(import.meta.dir, "../..");
  const compiled = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--allowImportingTsExtensions",
      "--module", "Preserve",
      "--moduleResolution", "Bundler",
      "--target", "ESNext",
      "--lib", "ESNext,DOM,DOM.Iterable",
      "--types", "bun,node",
      "--pretty", "false",
      import.meta.path,
    ],
    { cwd: root, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  if (compiled.error) throw compiled.error;
  expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
}, 25_000);

const legacyVariableRequirement = {
  kind: "identity.oidc",
  callbackPath: "/auth/oidc/callback",
  scopes: ["openid"],
  deliver: {
    variables: {
      issuerUrl: "OIDC_ISSUER",
      accountsUrl: "ACCOUNTS_URL",
      clientId: "OIDC_CLIENT_ID",
      redirectUri: "OIDC_REDIRECT_URI",
    },
  },
} as const;

const legacyBindingRequirement = {
  kind: "identity.oidc",
  callbackPath: "/auth/oidc/callback",
  scopes: ["openid"],
  deliver: {
    bindings: {
      issuerUrl: "OIDC_ISSUER",
      accountsUrl: "ACCOUNTS_URL",
      clientId: "OIDC_CLIENT_ID",
      redirectUri: "OIDC_REDIRECT_URI",
    },
  },
} as const;

const v24BindingRequirement = {
  kind: "identity.oidc",
  callbackPath: "/auth/oidc/callback",
  scopes: ["openid"],
  deliver: {
    bindings: {
      issuerUrl: "OIDC_ISSUER",
      clientId: "OIDC_CLIENT_ID",
      ownerSubject: "OIDC_OWNER_SUBJECT",
      redirectUri: "OIDC_REDIRECT_URI",
    },
  },
} as const;

const variableOwnerSubjectRequirement = {
  kind: "identity.oidc",
  callbackPath: "/auth/oidc/callback",
  deliver: {
    variables: {
      issuerUrl: "OIDC_ISSUER",
      accountsUrl: "ACCOUNTS_URL",
      clientId: "OIDC_CLIENT_ID",
      ownerSubject: "OIDC_OWNER_SUBJECT",
      redirectUri: "OIDC_REDIRECT_URI",
    },
  },
} as const;

const legacyBindingOwnerSubjectRequirement = {
  kind: "identity.oidc",
  callbackPath: "/auth/oidc/callback",
  deliver: {
    bindings: {
      issuerUrl: "OIDC_ISSUER",
      accountsUrl: "ACCOUNTS_URL",
      clientId: "OIDC_CLIENT_ID",
      ownerSubject: "OIDC_OWNER_SUBJECT",
      redirectUri: "OIDC_REDIRECT_URI",
    },
  },
} as const;

const v24BindingAccountsUrlRequirement = {
  kind: "identity.oidc",
  callbackPath: "/auth/oidc/callback",
  deliver: {
    bindings: {
      issuerUrl: "OIDC_ISSUER",
      accountsUrl: "ACCOUNTS_URL",
      clientId: "OIDC_CLIENT_ID",
      ownerSubject: "OIDC_OWNER_SUBJECT",
      redirectUri: "OIDC_REDIRECT_URI",
    },
  },
} as const;

const legacyVariableModule = {
  inputs: [],
  requires: [legacyVariableRequirement],
} as const;

const legacyBindingModule = {
  inputs: [],
  requires: [legacyBindingRequirement],
} as const;

const v24BindingModule = {
  inputs: [],
  requires: [v24BindingRequirement],
} as const;

const v1VariableDocument = {
  apiVersion: "takosumi.com/v1",
  kind: "Repository",
  install: { modules: { ".": legacyVariableModule } },
} as const satisfies RepositoryManifestDocumentV1;

const v2VariableDocument = {
  apiVersion: "takosumi.com/v2",
  kind: "Repository",
  install: { modules: { ".": legacyVariableModule } },
} as const satisfies RepositoryManifestDocumentV2;

const v21VariableDocument = {
  apiVersion: "takosumi.com/v2.1",
  kind: "Repository",
  install: { modules: { ".": legacyVariableModule } },
} as const satisfies RepositoryManifestDocumentV2_1;

const v22VariableDocument = {
  apiVersion: "takosumi.com/v2.2",
  kind: "Repository",
  install: { modules: { ".": legacyVariableModule } },
} as const satisfies RepositoryManifestDocumentV2_2;

const v23VariableDocument = {
  apiVersion: "takosumi.com/v2.3",
  kind: "Repository",
  install: { modules: { ".": legacyVariableModule } },
} as const satisfies RepositoryManifestDocumentV2_3;

const v24VariableDocument = {
  apiVersion: "takosumi.com/v2.4",
  kind: "Repository",
  install: { modules: { ".": legacyVariableModule } },
} as const satisfies RepositoryManifestDocumentV2_4;

const v1BindingDocument = {
  apiVersion: "takosumi.com/v1",
  kind: "Repository",
  install: { modules: { ".": legacyBindingModule } },
} as const satisfies RepositoryManifestDocumentV1;

const v2BindingDocument = {
  apiVersion: "takosumi.com/v2",
  kind: "Repository",
  install: { modules: { ".": legacyBindingModule } },
} as const satisfies RepositoryManifestDocumentV2;

const v21BindingDocument = {
  apiVersion: "takosumi.com/v2.1",
  kind: "Repository",
  install: { modules: { ".": legacyBindingModule } },
} as const satisfies RepositoryManifestDocumentV2_1;

const v22BindingDocument = {
  apiVersion: "takosumi.com/v2.2",
  kind: "Repository",
  install: { modules: { ".": legacyBindingModule } },
} as const satisfies RepositoryManifestDocumentV2_2;

const v23BindingDocument = {
  apiVersion: "takosumi.com/v2.3",
  kind: "Repository",
  install: { modules: { ".": legacyBindingModule } },
} as const satisfies RepositoryManifestDocumentV2_3;

const v24BindingDocument = {
  apiVersion: "takosumi.com/v2.4",
  kind: "Repository",
  install: { modules: { ".": v24BindingModule } },
} as const satisfies RepositoryManifestDocumentV2_4;

const invalidLegacyBindingModule = {
  inputs: [],
  requires: [legacyBindingOwnerSubjectRequirement],
} as const;

const invalidV24BindingModule = {
  inputs: [],
  requires: [v24BindingAccountsUrlRequirement],
} as const;

const invalidVariableModule = {
  inputs: [],
  requires: [variableOwnerSubjectRequirement],
} as const;

const invalidV1BindingOwnerSubject = {
  apiVersion: "takosumi.com/v1",
  kind: "Repository",
  install: { modules: { ".": invalidLegacyBindingModule } },
} as const;
// @ts-expect-error v1 binding delivery has no v2.4-only ownerSubject slot.
const rejectedV1BindingOwnerSubject: RepositoryManifestDocumentV1 =
  invalidV1BindingOwnerSubject;

const invalidV2BindingOwnerSubject = {
  apiVersion: "takosumi.com/v2",
  kind: "Repository",
  install: { modules: { ".": invalidLegacyBindingModule } },
} as const;
// @ts-expect-error v2 binding delivery has no v2.4-only ownerSubject slot.
const rejectedV2BindingOwnerSubject: RepositoryManifestDocumentV2 =
  invalidV2BindingOwnerSubject;

const invalidV21BindingOwnerSubject = {
  apiVersion: "takosumi.com/v2.1",
  kind: "Repository",
  install: { modules: { ".": invalidLegacyBindingModule } },
} as const;
// @ts-expect-error v2.1 binding delivery has no v2.4-only ownerSubject slot.
const rejectedV21BindingOwnerSubject: RepositoryManifestDocumentV2_1 =
  invalidV21BindingOwnerSubject;

const invalidV22BindingOwnerSubject = {
  apiVersion: "takosumi.com/v2.2",
  kind: "Repository",
  install: { modules: { ".": invalidLegacyBindingModule } },
} as const;
// @ts-expect-error v2.2 binding delivery has no v2.4-only ownerSubject slot.
const rejectedV22BindingOwnerSubject: RepositoryManifestDocumentV2_2 =
  invalidV22BindingOwnerSubject;

const invalidV23BindingOwnerSubject = {
  apiVersion: "takosumi.com/v2.3",
  kind: "Repository",
  install: { modules: { ".": invalidLegacyBindingModule } },
} as const;
// @ts-expect-error v2.3 binding delivery has no v2.4-only ownerSubject slot.
const rejectedV23BindingOwnerSubject: RepositoryManifestDocumentV2_3 =
  invalidV23BindingOwnerSubject;

const invalidV24BindingAccountsUrl = {
  apiVersion: "takosumi.com/v2.4",
  kind: "Repository",
  install: { modules: { ".": invalidV24BindingModule } },
} as const;
// @ts-expect-error v2.4 binding delivery replaced accountsUrl with ownerSubject.
const rejectedV24BindingAccountsUrl: RepositoryManifestDocumentV2_4 =
  invalidV24BindingAccountsUrl;

const invalidV1VariableOwnerSubject = {
  apiVersion: "takosumi.com/v1",
  kind: "Repository",
  install: { modules: { ".": invalidVariableModule } },
} as const;
// @ts-expect-error variables never carry the ownerSubject binding slot.
const rejectedV1VariableOwnerSubject: RepositoryManifestDocumentV1 =
  invalidV1VariableOwnerSubject;

const invalidV2VariableOwnerSubject = {
  apiVersion: "takosumi.com/v2",
  kind: "Repository",
  install: { modules: { ".": invalidVariableModule } },
} as const;
// @ts-expect-error variables never carry the ownerSubject binding slot.
const rejectedV2VariableOwnerSubject: RepositoryManifestDocumentV2 =
  invalidV2VariableOwnerSubject;

const invalidV21VariableOwnerSubject = {
  apiVersion: "takosumi.com/v2.1",
  kind: "Repository",
  install: { modules: { ".": invalidVariableModule } },
} as const;
// @ts-expect-error variables never carry the ownerSubject binding slot.
const rejectedV21VariableOwnerSubject: RepositoryManifestDocumentV2_1 =
  invalidV21VariableOwnerSubject;

const invalidV22VariableOwnerSubject = {
  apiVersion: "takosumi.com/v2.2",
  kind: "Repository",
  install: { modules: { ".": invalidVariableModule } },
} as const;
// @ts-expect-error variables never carry the ownerSubject binding slot.
const rejectedV22VariableOwnerSubject: RepositoryManifestDocumentV2_2 =
  invalidV22VariableOwnerSubject;

const invalidV23VariableOwnerSubject = {
  apiVersion: "takosumi.com/v2.3",
  kind: "Repository",
  install: { modules: { ".": invalidVariableModule } },
} as const;
// @ts-expect-error variables never carry the ownerSubject binding slot.
const rejectedV23VariableOwnerSubject: RepositoryManifestDocumentV2_3 =
  invalidV23VariableOwnerSubject;

const invalidV24VariableOwnerSubject = {
  apiVersion: "takosumi.com/v2.4",
  kind: "Repository",
  install: { modules: { ".": invalidVariableModule } },
} as const;
// @ts-expect-error variables never carry the ownerSubject binding slot.
const rejectedV24VariableOwnerSubject: RepositoryManifestDocumentV2_4 =
  invalidV24VariableOwnerSubject;

const oidcBothDeliverySurfaces = {
  kind: "identity.oidc",
  callbackPath: "/auth/oidc/callback",
  deliver: {
    variables: { issuerUrl: "OIDC_ISSUER" },
    bindings: { issuerUrl: "OIDC_ISSUER" },
  },
} as const;
// @ts-expect-error an OIDC requirement must choose exactly one delivery surface.
const rejectedOidcBothDeliverySurfaces: RepositoryRuntimeRequirement =
  oidcBothDeliverySurfaces;

const secretBothDeliverySurfaces = {
  variables: { value: "APP_SECRET" },
  bindings: { value: "APP_SECRET" },
} as const;
// @ts-expect-error a runtime delivery must choose exactly one delivery surface.
const rejectedSecretBothDeliverySurfaces: RepositoryRuntimeDelivery<"value"> =
  secretBothDeliverySurfaces;

const endpointBothDeliverySurfaces = {
  variables: { url: "PUBLIC_URL" },
  bindings: { url: "PUBLIC_URL" },
} as const;
// @ts-expect-error a runtime delivery must choose exactly one delivery surface.
const rejectedEndpointBothDeliverySurfaces: RepositoryRuntimeDelivery<
  "url"
> = endpointBothDeliverySurfaces;

// @ts-expect-error the discriminated document union must retain v2.3's slot set.
const rejectedByVersionedDocumentUnion: RepositoryManifestDocument =
  invalidV23BindingOwnerSubject;

// @ts-expect-error the discriminated document union must reject ownerSubject in variables.
const rejectedVariableOwnerSubjectByVersionedDocumentUnion: RepositoryManifestDocument =
  invalidV24VariableOwnerSubject;
