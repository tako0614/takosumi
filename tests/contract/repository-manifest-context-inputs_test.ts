import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";

import v21Schema from "../../docs/public/schemas/repository-manifest-v2.1.schema.json" with { type: "json" };
import v25Schema from "../../docs/public/schemas/repository-manifest-v2.5.schema.json" with { type: "json" };

import { parseRepositoryManifestText } from "../../contract/repository-manifest.ts";
import type {
  RepositoryManifestDocumentV1,
  RepositoryManifestDocumentV2_4,
  RepositoryManifestDocumentV2_5,
} from "../../contract/repository-manifest.ts";

type AssertFalse<T extends false> = T;
export type LegacyV1ContextKindsStayClosed = AssertFalse<
  "workspace_id" extends RepositoryManifestDocumentV1["install"]["modules"][string]["inputs"][number]["source"]["kind"]
    ? true
    : false
>;
export type LegacyV24ContextKindsStayClosed = AssertFalse<
  "capsule_id" extends RepositoryManifestDocumentV2_4["install"]["modules"][string]["inputs"][number]["source"]["kind"]
    ? true
    : false
>;
export type V25ScopedNamesStayRetired = AssertFalse<
  "workspace_scoped_capsule_name" extends RepositoryManifestDocumentV2_5["install"]["modules"][string]["inputs"][number]["source"]["kind"]
    ? true
    : false
>;

function contextDocument(apiVersion = "takosumi.com/v2.5") {
  return {
    apiVersion,
    kind: "Repository",
    install: {
      modules: {
        ".": {
          inputs: [
            {
              name: "app_workspace_id",
              source: { kind: "workspace_id" },
              type: "string",
              label: { ja: "現在の領域", en: "Current installation scope" },
            },
            {
              name: "app_capsule_id",
              source: { kind: "capsule_id" },
              type: "string",
              label: { ja: "現在のアプリ", en: "Current installation" },
            },
          ],
        },
      },
    },
  };
}

test("v2.5 accepts explicit current-context sources without literal identities", () => {
  const parsed = parseRepositoryManifestText(JSON.stringify(contextDocument()));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.install.modules["."]?.inputs.map((input) => input.source))
    .toEqual([{ kind: "workspace_id" }, { kind: "capsule_id" }]);
});

test("published older versions and unknown future versions do not inherit context sources", () => {
  for (const version of ["v1", "v2", "v2.1", "v2.2", "v2.3", "v2.4", "v2.6"]) {
    const parsed = parseRepositoryManifestText(
      JSON.stringify(contextDocument(`takosumi.com/${version}`)),
    );
    expect(parsed.ok).toBe(false);
  }
});

test("v2.5 does not carry forward Workspace-scoped naming from older manifests", () => {
  const document = contextDocument();
  document.install.modules["."].inputs = [{
    name: "service_name",
    source: { kind: "workspace_scoped_capsule_name" },
    type: "string",
    label: { ja: "名前", en: "Name" },
  }];
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
  document.apiVersion = "takosumi.com/v2.4";
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(true);
});

test("context source declarations cannot carry literal identity or presentation knobs", () => {
  for (const [key, value] of Object.entries({
    role: "service_name",
    secret: false,
    required: false,
    advanced: false,
    format: "subdomain",
    helper: { ja: "help", en: "help" },
    placeholder: "value",
    workspaceId: "ws_caller_supplied",
    capsuleId: "cap_caller_supplied",
  })) {
    const document = contextDocument();
    Object.assign(document.install.modules["."].inputs[0]!, { [key]: value });
    expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
  }
  const document = contextDocument();
  Object.assign(document.install.modules["."].inputs[0]!.source, {
    value: "ws_caller_supplied",
  });
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
});

test("context inputs retain root-only names and string declaration shape", () => {
  for (const name of ["env", "env.APP_WORKSPACE_ID", "__proto__", "constructor", "prototype"]) {
    const document = contextDocument();
    document.install.modules["."].inputs[0]!.name = name;
    expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
  }
  for (const type of ["number", "boolean", "json"]) {
    const document = contextDocument();
    document.install.modules["."].inputs[0]!.type = type;
    expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
  }
});

test("optional features cannot turn context data into a user choice", () => {
  const document = contextDocument();
  Object.assign(document.install.modules["."], {
    features: [{
      id: "scope",
      optional: true,
      label: { ja: "scope", en: "scope" },
      inputs: ["app_workspace_id"],
    }],
  });
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
});

test("v2.5 preserves v2.4 runtime declarations and rejects the retired module hint", () => {
  const document = contextDocument();
  Object.assign(document.install.modules["."], {
    sourceBuild: {
      commands: [{ argv: ["bun", "run", "build"] }],
      outputs: ["dist/app.mjs"],
    },
    requires: [{
      kind: "identity.oidc",
      callbackPath: "/auth/callback",
      scopes: ["openid"],
      deliver: { bindings: {
        issuerUrl: "ISSUER",
        clientId: "CLIENT",
        ownerSubject: "OWNER",
        redirectUri: "CALLBACK",
      } },
    }, {
      kind: "secret.generated",
      bytes: 32,
      encoding: "hex",
      deliver: { bindings: { value: "SESSION_SECRET" } },
    }],
  });
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(true);
  Object.assign(document.install, { defaultModule: "." });
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
});

test("published v2.5 schema accepts only the bounded context declaration shape", () => {
  // Match the published-schema suite; parser-owned semantics remain tested above.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(v21Schema);
  const validate = ajv.compile(v25Schema);
  expect(validate(contextDocument())).toBe(true);
  for (const patch of [
    { name: "env.APP_WORKSPACE_ID" },
    { name: "env" },
    { name: "constructor" },
    { type: "json" },
    { secret: false },
    { required: false },
    { role: "service_name" },
    { source: { kind: "workspace_id", value: "ws_caller_supplied" } },
    { source: { kind: "workspace_scoped_capsule_name" } },
  ]) {
    const document = contextDocument();
    Object.assign(document.install.modules["."].inputs[0]!, patch);
    expect(validate(document)).toBe(false);
    expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
  }
});
