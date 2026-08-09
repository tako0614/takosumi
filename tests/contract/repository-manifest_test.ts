import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { join } from "node:path";

import repositoryManifestV2_1Schema from "../../docs/public/schemas/repository-manifest-v2.1.schema.json" with { type: "json" };
import repositoryManifestV2_2Schema from "../../docs/public/schemas/repository-manifest-v2.2.schema.json" with { type: "json" };
import repositoryManifestV2_3Schema from "../../docs/public/schemas/repository-manifest-v2.3.schema.json" with { type: "json" };

import {
  parseRepositoryManifestText,
  TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES,
} from "../../contract/repository-manifest.ts";

const fixtureDirectory = join(
  import.meta.dir,
  "fixtures",
  "repository-manifest",
);

async function fixture(name: string): Promise<string> {
  return await Bun.file(join(fixtureDirectory, name)).text();
}

test("repository manifest accepts the closed v1 install proposal", async () => {
  const parsed = parseRepositoryManifestText(await fixture("valid.json"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.apiVersion).toBe("takosumi.com/v1");
  expect(parsed.document.kind).toBe("Repository");
  expect(
    parsed.document.install.modules["."]?.inputs.map((input) => input.name),
  ).toEqual([
    "project_name",
    "app_url",
    "notification_push_gateway_url",
    "notification_push_gateway_token",
    "accounts_issuer_url",
    "accounts_client_id",
  ]);
  expect(
    parsed.document.install.modules["."]?.requires?.map(
      (requirement) => requirement.kind,
    ),
  ).toEqual(["http.endpoint", "identity.oidc", "secret.generated"]);
  expect(
    parsed.document.install.modules["."]?.inputs.find(
      (input) => input.role !== undefined,
    ),
  ).toMatchObject({ name: "project_name", role: "service_name" });
});

test("repository manifest v2.2 declares consumed Interfaces without ids or credentials", () => {
  const parsed = parseRepositoryManifestText(
    JSON.stringify({
      apiVersion: "takosumi.com/v2.2",
      kind: "Repository",
      install: {
        defaultModule: ".",
        modules: {
          ".": {
            inputs: [],
            requires: [
              {
                kind: "interface.consume",
                key: "ai",
                interface: { type: "takosumi.ai.gateway", version: "1" },
                permissions: ["ai.chat"],
                delivery: { type: "oauth2" },
              },
            ],
          },
        },
      },
    }),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.install.modules["."]?.requires).toEqual([
    {
      kind: "interface.consume",
      key: "ai",
      interface: { type: "takosumi.ai.gateway", version: "1" },
      permissions: ["ai.chat"],
      delivery: { type: "oauth2" },
    },
  ]);

  const oldVersion = JSON.parse(JSON.stringify(parsed.document)) as Record<
    string,
    unknown
  >;
  oldVersion.apiVersion = "takosumi.com/v2.1";
  expect(parseRepositoryManifestText(JSON.stringify(oldVersion))).toEqual({
    ok: false,
    error: 'install.modules.".".requires[0].kind is unsupported',
  });
});

test("repository manifest rejects unknown authority, fields, and versions", async () => {
  expect(
    parseRepositoryManifestText(await fixture("unknown-key.json")),
  ).toEqual({
    ok: false,
    error: "contains unsupported field providers",
  });
  expect(
    parseRepositoryManifestText(await fixture("unknown-version.json")),
  ).toEqual({
    ok: false,
    error:
      "apiVersion must be takosumi.com/v1, takosumi.com/v2, takosumi.com/v2.1, takosumi.com/v2.2, or takosumi.com/v2.3",
  });
  expect(
    parseRepositoryManifestText(
      '{"schemaVersion":"takosumi.install-ux/v1","modules":{".":{"inputs":[]}}}',
    ),
  ).toEqual({
    ok: false,
    error: "contains unsupported field schemaVersion",
  });
  const schemaHint = JSON.parse(await fixture("valid.json"));
  schemaHint.$schema = "https://example.test/takosumi.schema.json";
  expect(parseRepositoryManifestText(JSON.stringify(schemaHint))).toEqual({
    ok: false,
    error: "contains unsupported field $schema",
  });
});

test("repository manifest v2.3 accepts only the bounded credential-free sourceBuild proposal", () => {
  const document = {
    apiVersion: "takosumi.com/v2.3",
    kind: "Repository",
    install: {
      defaultModule: ".",
      modules: {
        ".": {
          inputs: [],
          sourceBuild: {
            commands: [
              { argv: ["bun", "install", "--frozen-lockfile"] },
              { argv: ["bun", "run", "build"], workingDirectory: "web" },
            ],
            outputs: ["web/dist/index.js"],
          },
        },
      },
    },
  };
  const parsed = parseRepositoryManifestText(JSON.stringify(document));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.apiVersion).toBe("takosumi.com/v2.3");
  expect(parsed.document.install.modules["."]?.sourceBuild).toEqual(
    document.install.modules["."].sourceBuild,
  );

  const earlierVersion = structuredClone(document);
  earlierVersion.apiVersion = "takosumi.com/v2.2";
  expect(parseRepositoryManifestText(JSON.stringify(earlierVersion))).toEqual({
    ok: false,
    error: 'install.modules.".".contains unsupported field sourceBuild',
  });

  const mutations: readonly [string, (value: typeof document) => void][] = [
    [
      "env",
      (value) => ((value.install.modules["."].sourceBuild as any).env = {}),
    ],
    [
      "unsafe argv",
      (value) => {
        value.install.modules["."].sourceBuild.commands[0].argv = ["bun\0run"];
      },
    ],
    [
      "unsafe output",
      (value) => {
        value.install.modules["."].sourceBuild.outputs = ["../dist/app.js"];
      },
    ],
    [
      "unsafe working directory",
      (value) => {
        value.install.modules["."].sourceBuild.commands[1].workingDirectory =
          "../web";
      },
    ],
  ];
  for (const [label, mutate] of mutations) {
    const invalid = structuredClone(document);
    mutate(invalid);
    expect(parseRepositoryManifestText(JSON.stringify(invalid)).ok, label).toBe(
      false,
    );
  }

  for (const output of [
    " ./dist/app.js ",
    "dist\\app.js",
    "dist//app.js",
    "dist/./app.js",
  ]) {
    const nonCanonical = structuredClone(document);
    nonCanonical.install.modules["."].sourceBuild.outputs = [output];
    expect(parseRepositoryManifestText(JSON.stringify(nonCanonical))).toEqual({
      ok: false,
      error:
        'install.modules.".".sourceBuild.outputs[0] must be a safe relative produced path',
    });
  }
});

test("repository manifest rejects traversal and duplicate app vocabulary", async () => {
  expect(parseRepositoryManifestText(await fixture("traversal.json")).ok).toBe(
    false,
  );
  expect(parseRepositoryManifestText(await fixture("duplicate.json"))).toEqual({
    ok: false,
    error: 'install.modules.".".inputs[1].name must be unique',
  });
});

test("repository manifest rejects secret env maps and unsupported requirements", async () => {
  expect(
    parseRepositoryManifestText(await fixture("secret-leak.json")),
  ).toEqual({
    ok: false,
    error:
      'install.modules.".".inputs[0].secret must not target the plain env variable',
  });
  expect(
    parseRepositoryManifestText(await fixture("unsupported-requirement.json")),
  ).toEqual({
    ok: false,
    error: 'install.modules.".".requires[0].kind is unsupported',
  });

  const unknownSource = JSON.parse(await fixture("valid.json"));
  unknownSource.install.modules["."].inputs[0].source.kind = "command";
  expect(parseRepositoryManifestText(JSON.stringify(unknownSource))).toEqual({
    ok: false,
    error: 'install.modules.".".inputs[0].source.kind is unsupported',
  });
});

test("repository manifest enforces the UTF-8 byte limit", () => {
  const oversized = "界".repeat(
    Math.floor(TAKOSUMI_REPOSITORY_MANIFEST_MAX_BYTES / 3) + 1,
  );
  expect(parseRepositoryManifestText(oversized)).toEqual({
    ok: false,
    error: "document exceeds 128 KiB",
  });
});

test("repository manifest rejects module aliases and unsafe callback paths", async () => {
  const alias = JSON.parse(await fixture("valid.json"));
  alias.install.modules["./deploy"] = alias.install.modules["."];
  delete alias.install.modules["."];
  expect(parseRepositoryManifestText(JSON.stringify(alias)).ok).toBe(false);

  const originCallback = JSON.parse(await fixture("valid.json"));
  originCallback.install.modules["."].requires[1].callbackPath =
    "https://example.com/callback";
  expect(parseRepositoryManifestText(JSON.stringify(originCallback)).ok).toBe(
    false,
  );
});

test("a requirement names exactly one delivery surface", async () => {
  const both = JSON.parse(await fixture("valid.json"));
  both.install.modules["."].requires[2].deliver = {
    variables: { value: "app_url" },
    bindings: { value: "ENCRYPTION_KEY" },
  };
  expect(parseRepositoryManifestText(JSON.stringify(both))).toEqual({
    ok: false,
    error:
      'install.modules.".".requires[2].deliver must declare exactly one of variables or bindings',
  });

  const neither = JSON.parse(await fixture("valid.json"));
  neither.install.modules["."].requires[2].deliver = {};
  expect(parseRepositoryManifestText(JSON.stringify(neither)).ok).toBe(false);
});

test("a generated secret stays inside reviewed size bounds", async () => {
  for (const bytes of [8, 128, 32.5]) {
    const document = JSON.parse(await fixture("valid.json"));
    document.install.modules["."].requires[2].bytes = bytes;
    expect(parseRepositoryManifestText(JSON.stringify(document))).toEqual({
      ok: false,
      error:
        'install.modules.".".requires[2].bytes must be an integer between 16 and 64',
    });
  }
});

test("a module may declare no more than eight generated secrets", async () => {
  const document = JSON.parse(await fixture("valid.json"));
  document.install.modules["."].requires = Array.from(
    { length: 9 },
    (_, index) => ({
      kind: "secret.generated",
      deliver: { bindings: { value: `GENERATED_SECRET_${index}` } },
    }),
  );

  expect(parseRepositoryManifestText(JSON.stringify(document))).toEqual({
    ok: false,
    error:
      'install.modules.".".requires declares more than 8 generated secrets',
  });
});

test("known secret-like presentation values are rejected before compile", async () => {
  const mutations: readonly [string, (document: any) => void][] = [
    [
      "input label",
      (document) => {
        document.install.modules["."].inputs[0].label.en =
          "sk-example_12345678";
      },
    ],
    [
      "input helper",
      (document) => {
        document.install.modules["."].inputs[1].helper.en =
          "sk-example_12345678";
      },
    ],
    [
      "input placeholder",
      (document) => {
        document.install.modules["."].inputs[1].placeholder =
          "sk-example_12345678";
      },
    ],
    [
      "feature label",
      (document) => {
        document.install.modules["."].features[0].label.ja =
          "sk-example_12345678";
      },
    ],
  ];

  for (const [field, mutate] of mutations) {
    const document = JSON.parse(await fixture("valid.json"));
    mutate(document);
    const parsed = parseRepositoryManifestText(JSON.stringify(document));
    expect(parsed.ok, field).toBe(false);
    if (parsed.ok) continue;
    expect(parsed.error, field).toContain("<secret-like-string>");
  }

  const ordinaryProse = JSON.parse(await fixture("valid.json"));
  ordinaryProse.install.modules["."].inputs[1].helper.en =
    "Use a token value supplied by the operator.";
  expect(parseRepositoryManifestText(JSON.stringify(ordinaryProse)).ok).toBe(
    true,
  );
});

test("identifier whitespace is rejected instead of being trimmed", async () => {
  const inputName = JSON.parse(await fixture("valid.json"));
  inputName.install.modules["."].inputs[0].name = " project_name ";
  expect(parseRepositoryManifestText(JSON.stringify(inputName))).toEqual({
    ok: false,
    error:
      'install.modules.".".inputs[0].name must be a valid OpenTofu variable name',
  });

  const deliveryName = JSON.parse(await fixture("valid.json"));
  deliveryName.install.modules["."].requires[0].deliver.variables.url =
    " app_url ";
  expect(parseRepositoryManifestText(JSON.stringify(deliveryName))).toEqual({
    ok: false,
    error:
      'install.modules.".".requires[0].deliver.variables.url must be a valid OpenTofu variable name',
  });
});

test("two requirements cannot claim the same delivered name", async () => {
  const document = JSON.parse(await fixture("valid.json"));
  document.install.modules["."].requires[1].deliver = {
    variables: { issuerUrl: "app_url" },
  };
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
});

test("repository manifest treats special module names as data, not object prototypes", () => {
  const parsed = parseRepositoryManifestText(
    '{"apiVersion":"takosumi.com/v1","kind":"Repository","install":{"modules":{"__proto__":{"inputs":[]}}}}',
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(Object.hasOwn(parsed.document.install.modules, "__proto__")).toBe(
    true,
  );
  expect(parsed.document.install.modules.__proto__).toEqual({ inputs: [] });
});

test("repository manifest v2 accepts generic Capsule Interface declarations", async () => {
  const parsed = parseRepositoryManifestText(await fixture("v2-launcher.json"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.document.apiVersion).toBe("takosumi.com/v2");
  const declaration =
    parsed.document.install.modules["deploy/takoform"]?.interfaces?.[0];
  expect(declaration).toMatchObject({
    key: "launcher",
    name: "yurucommu.launcher",
    spec: {
      type: "interface.ui.surface",
      version: "1",
      inputs: {
        url: {
          source: "output",
          outputName: "launch_url",
          outputType: "url",
        },
      },
    },
    bindingRequests: [
      {
        key: "installer",
        subject: { source: "installing_principal" },
        permissions: ["ui.open"],
        delivery: { type: "none" },
      },
    ],
  });
});

test("repository manifest v1 and v2 remain closed against defaultModule", async () => {
  for (const apiVersion of ["takosumi.com/v1", "takosumi.com/v2"]) {
    const document = JSON.parse(await fixture("v2-launcher.json"));
    document.apiVersion = apiVersion;
    document.install.defaultModule = "deploy/takoform";
    if (apiVersion === "takosumi.com/v1") {
      delete document.install.modules["deploy/takoform"].interfaces;
    }

    expect(parseRepositoryManifestText(JSON.stringify(document))).toEqual({
      ok: false,
      error: "install.contains unsupported field defaultModule",
    });
  }
});

test("repository manifest v2.1 selects an exact default and preserves v2 Interfaces", async () => {
  const document = JSON.parse(await fixture("v2-launcher.json"));
  document.apiVersion = "takosumi.com/v2.1";
  document.install.defaultModule = "deploy/takoform";
  document.install.modules["."] = { inputs: [] };

  const parsed = parseRepositoryManifestText(JSON.stringify(document));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.document.apiVersion !== "takosumi.com/v2.1") {
    return;
  }
  expect(parsed.document.install.defaultModule).toBe("deploy/takoform");
  expect(
    parsed.document.install.modules["deploy/takoform"]?.interfaces?.[0]?.key,
  ).toBe("launcher");
});

test("repository manifest v2.1 rejects a non-canonical or absent default module key", async () => {
  for (const [defaultModule, error] of [
    [
      "./deploy/takoform",
      "install.defaultModule must be a canonical safe relative module path",
    ],
    [
      " deploy/takoform ",
      "install.defaultModule must be a canonical safe relative module path",
    ],
    [
      "deploy/missing",
      "install.defaultModule must name an exact install.modules key",
    ],
  ] as const) {
    const document = JSON.parse(await fixture("v2-launcher.json"));
    document.apiVersion = "takosumi.com/v2.1";
    document.install.defaultModule = defaultModule;

    expect(parseRepositoryManifestText(JSON.stringify(document))).toEqual({
      ok: false,
      error,
    });
  }
});

test("the published v2.1 schema covers structure while the parser owns semantics", async () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    repositoryManifestV2_1Schema,
  );
  const full = JSON.parse(await fixture("v2-launcher.json"));
  full.apiVersion = "takosumi.com/v2.1";
  full.install.defaultModule = "deploy/takoform";
  const minimal = {
    apiVersion: "takosumi.com/v2.1",
    kind: "Repository",
    install: { modules: { "deploy/only": { inputs: [] } } },
  };

  for (const document of [minimal, full]) {
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(true);
  }

  for (const mutate of [
    (document: Record<string, any>) => {
      document.install.unknown = true;
    },
    (document: Record<string, any>) => {
      document.install.defaultModule = "./deploy/takoform";
    },
    (document: Record<string, any>) => {
      document.install.modules[
        "deploy/takoform"
      ].interfaces[0].spec.access.visibility = "public";
    },
  ]) {
    const document = structuredClone(full);
    mutate(document);
    expect(validate(document)).toBe(false);
    expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(
      false,
    );
  }

  expect(
    repositoryManifestV2_1Schema["x-takosumi-semanticConstraints"],
  ).toContain(
    "install.defaultModule, when present, equals an own canonical key of install.modules",
  );
  expect(
    repositoryManifestV2_1Schema["x-takosumi-semanticConstraints"],
  ).toContain(
    "each module may declare at most 8 requires entries whose kind is secret.generated",
  );
  expect(
    repositoryManifestV2_1Schema["x-takosumi-semanticConstraints"],
  ).toContain(
    "JSON values in Interface documents and literal inputs are limited to recursive depth 32",
  );
  const missingKey = structuredClone(full);
  missingKey.install.defaultModule = "deploy/missing";
  expect(validate(missingKey)).toBe(true);
  expect(parseRepositoryManifestText(JSON.stringify(missingKey)).ok).toBe(
    false,
  );

  const whitespaceDefault = structuredClone(full);
  whitespaceDefault.install.defaultModule = " deploy/takoform ";
  expect(validate(whitespaceDefault)).toBe(false);
  expect(
    parseRepositoryManifestText(JSON.stringify(whitespaceDefault)).ok,
  ).toBe(false);

  const whitespaceModuleKey = structuredClone(full);
  whitespaceModuleKey.install.modules[" deploy/takoform "] =
    whitespaceModuleKey.install.modules["deploy/takoform"];
  delete whitespaceModuleKey.install.modules["deploy/takoform"];
  whitespaceModuleKey.install.defaultModule = " deploy/takoform ";
  expect(validate(whitespaceModuleKey)).toBe(false);
  expect(
    parseRepositoryManifestText(JSON.stringify(whitespaceModuleKey)).ok,
  ).toBe(false);
});

test("the published v2.2 schema adds only provider-neutral Interface consumption", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(repositoryManifestV2_1Schema);
  const validate = ajv.compile(repositoryManifestV2_2Schema);
  const document = {
    apiVersion: "takosumi.com/v2.2",
    kind: "Repository",
    install: {
      defaultModule: ".",
      modules: {
        ".": {
          inputs: [],
          requires: [
            {
              kind: "interface.consume",
              key: "ai",
              interface: { type: "takosumi.ai.gateway", version: "1" },
              permissions: ["ai.chat"],
              delivery: { type: "oauth2" },
            },
          ],
        },
      },
    },
  };

  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(true);

  for (const forbiddenField of ["id", "endpoint", "provider", "credential"]) {
    const invalid = structuredClone(document) as Record<string, any>;
    invalid.install.modules["."].requires[0].interface[forbiddenField] =
      "forbidden";
    expect(validate(invalid)).toBe(false);
    expect(parseRepositoryManifestText(JSON.stringify(invalid)).ok).toBe(false);
  }
});

test("parser-owned JSON depth and value scanning stay stricter than schema structure", async () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    repositoryManifestV2_1Schema,
  );
  const nested = (depth: number): unknown => {
    let value: unknown = "leaf";
    for (let index = 0; index < depth; index += 1) value = { value };
    return value;
  };

  const deep = JSON.parse(await fixture("v2-launcher.json"));
  deep.apiVersion = "takosumi.com/v2.1";
  deep.install.modules["deploy/takoform"].interfaces[0].spec.inputs = {
    config: { source: "literal", value: nested(33) },
  };
  expect(validate(deep)).toBe(true);
  expect(parseRepositoryManifestText(JSON.stringify(deep)).ok).toBe(false);

  const presentationSecret = JSON.parse(await fixture("v2-launcher.json"));
  presentationSecret.apiVersion = "takosumi.com/v2.1";
  presentationSecret.install.modules["deploy/takoform"].inputs = [
    {
      name: "project_name",
      source: { kind: "user" },
      label: { ja: "表示", en: "sk-example_12345678" },
    },
  ];
  expect(validate(presentationSecret)).toBe(true);
  expect(
    parseRepositoryManifestText(JSON.stringify(presentationSecret)).ok,
  ).toBe(false);

  const whitespaceIdentifier = JSON.parse(await fixture("v2-launcher.json"));
  whitespaceIdentifier.apiVersion = "takosumi.com/v2.1";
  whitespaceIdentifier.install.modules[
    "deploy/takoform"
  ].interfaces[0].spec.inputs.url.outputName = " launch_url ";
  expect(validate(whitespaceIdentifier)).toBe(false);
  expect(
    parseRepositoryManifestText(JSON.stringify(whitespaceIdentifier)).ok,
  ).toBe(false);

  const descriptiveIdentifiers = JSON.parse(await fixture("v2-launcher.json"));
  descriptiveIdentifiers.apiVersion = "takosumi.com/v2.1";
  const declaration =
    descriptiveIdentifiers.install.modules["deploy/takoform"].interfaces[0];
  declaration.key = "github_pat_repository_permissions";
  declaration.name = "ghp_configuration_profile";
  declaration.spec.type = "api_token";
  declaration.spec.version = "secret.read";
  declaration.spec.inputs.url.outputName = "api_token";
  expect(validate(descriptiveIdentifiers)).toBe(true);
  expect(
    parseRepositoryManifestText(JSON.stringify(descriptiveIdentifiers)).ok,
  ).toBe(true);

  const nineSecrets = JSON.parse(await fixture("v2-launcher.json"));
  nineSecrets.apiVersion = "takosumi.com/v2.1";
  nineSecrets.install.modules["deploy/takoform"].requires = Array.from(
    { length: 9 },
    (_, index) => ({
      kind: "secret.generated",
      deliver: { bindings: { value: `GENERATED_SECRET_${index}` } },
    }),
  );
  expect(validate(nineSecrets)).toBe(false);
  expect(parseRepositoryManifestText(JSON.stringify(nineSecrets)).ok).toBe(
    false,
  );
});

test("repository manifest v1 rejects the v2 interfaces section", async () => {
  expect(
    parseRepositoryManifestText(await fixture("v1-interfaces-rejected.json")),
  ).toEqual({
    ok: false,
    error: 'install.modules.".".contains unsupported field interfaces',
  });
});

test("repository manifest v2 rejects forbidden subjects and credential fields", async () => {
  expect(
    parseRepositoryManifestText(await fixture("v2-forbidden-subject.json")).ok,
  ).toBe(false);
  expect(
    parseRepositoryManifestText(await fixture("v2-secret-delivery.json")),
  ).toEqual({
    ok: false,
    error:
      'install.modules.".".interfaces[0].bindingRequests[0].delivery.contains unsupported field credentialRef',
  });
});

test("repository manifest v2 rejects duplicate output types and malformed inputs", async () => {
  expect(
    parseRepositoryManifestText(await fixture("v2-duplicate.json")),
  ).toEqual({
    ok: false,
    error:
      'install.modules.".".interfaces[1].spec.inputs output "launch_url" has conflicting outputType declarations',
  });
  expect(
    parseRepositoryManifestText(await fixture("v2-malformed.json")).ok,
  ).toBe(false);
});

test("repository manifest v2 rejects secret-like document fields", () => {
  const document = {
    apiVersion: "takosumi.com/v2",
    kind: "Repository",
    install: {
      modules: {
        ".": {
          inputs: [],
          interfaces: [
            {
              key: "launcher",
              name: "example.launcher",
              spec: {
                type: "example",
                version: "1",
                document: { display: { title: "Example" }, token: "secret" },
                access: { visibility: "workspace" },
              },
            },
          ],
        },
      },
    },
  };
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
});

test("repository manifest v2 rejects secret-like values and authority IDs recursively", async () => {
  const document = JSON.parse(await fixture("v2-launcher.json"));
  const declaration = document.install.modules["deploy/takoform"].interfaces[0];
  for (const key of [
    "providerId",
    "credentialId",
    "accountId",
    "hostId",
    "provider_id",
    "credential_id",
    "account_id",
    "host_id",
  ]) {
    declaration.spec.document = {
      display: { title: "Example" },
      nested: { authority: { [key]: "opaque-id" } },
    };
    expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(
      false,
    );
  }

  for (const value of ["sk-example_12345678", "Bearer opaque-token"]) {
    declaration.spec.document = {
      display: { title: "Example" },
      nested: { values: [value] },
    };
    expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(
      false,
    );
  }

  declaration.spec.document = { display: { title: "Example" } };
  declaration.spec.inputs.literal = {
    source: "literal",
    value: { nested: { credentialId: "credential_123" } },
  };
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
});

test("repository manifest v2 bounds one installer binding and workspace access", async () => {
  const document = JSON.parse(await fixture("v2-launcher.json"));
  const declaration = document.install.modules["deploy/takoform"].interfaces[0];
  declaration.spec.access.visibility = "public";
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);

  declaration.spec.access.visibility = "workspace";
  declaration.spec.access.policyRef = "operator-policy";
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);

  delete declaration.spec.access.policyRef;
  declaration.bindingRequests.push({
    key: "second",
    subject: { source: "installing_principal" },
    permissions: ["ui.open"],
    delivery: { type: "none" },
  });
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(false);
});

test("the published v2.3 schema and parser agree on closed sourceBuild paths", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(repositoryManifestV2_1Schema);
  const validate = ajv.compile(repositoryManifestV2_3Schema);
  const document = {
    apiVersion: "takosumi.com/v2.3",
    kind: "Repository",
    install: {
      modules: {
        ".": {
          inputs: [],
          sourceBuild: {
            commands: [
              { argv: ["bun", "run", "build"], workingDirectory: "web" },
            ],
            outputs: ["web/dist/index.js"],
          },
        },
      },
    },
  };
  expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  expect(parseRepositoryManifestText(JSON.stringify(document)).ok).toBe(true);

  const unknownField = structuredClone(document);
  (
    unknownField.install.modules["."]!.sourceBuild as Record<string, unknown>
  ).env = {};
  expect(validate(unknownField)).toBe(false);
  expect(parseRepositoryManifestText(JSON.stringify(unknownField)).ok).toBe(
    false,
  );

  const dotOutput = structuredClone(document);
  dotOutput.install.modules["."]!.sourceBuild.outputs = ["."];
  expect(validate(dotOutput)).toBe(false);
  expect(parseRepositoryManifestText(JSON.stringify(dotOutput)).ok).toBe(false);
});
