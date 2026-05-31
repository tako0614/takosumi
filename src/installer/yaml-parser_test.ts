import { expect, test } from "bun:test";
import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.5";
import {
  AppSpecParseError,
  type AppSpecParseLogger,
  KNOWN_LISTEN_SHAPES,
  parseAppSpec,
} from "./yaml-parser.ts";

test("parseAppSpec accepts canonical connect + platform listen + root publish example", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata:
  id: com.example.notes
  name: Example Notes
components:
  db:
    kind: postgres
    spec:
      version: "16"
  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: secret-env
        prefix: DB
    listen:
      identity:
        path: identity.primary.oidc
        inject: secret-env
        prefix: IDENTITY
        required: true
    spec:
      entrypoint: dist/worker.mjs
  public:
    kind: gateway
    connect:
      app:
        output: web.http
        inject: upstream
    spec:
      listeners:
        public:
          protocol: https
          host: notes.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
publish:
  api:
    output: web.http
    kind: http-endpoint
    path: acme.notes.api
    labels:
      app: notes
`);

  expect(spec.apiVersion).toEqual("v1");
  expect(spec.components.web.connect?.db?.output).toEqual("db.connection");
  expect(spec.components.web.connect?.db?.inject).toEqual("secret-env");
  expect(spec.components.web.listen?.identity?.path).toEqual("identity.primary.oidc");
  expect(spec.components.public.connect?.app?.inject).toEqual("upstream");
  expect(spec.publish?.api?.output).toEqual("web.http");
  expect(spec.publish?.api?.kind).toEqual("http-endpoint");
  expect(spec.publish?.api?.path).toEqual("acme.notes.api");
  expect(spec.publish?.api?.labels?.app).toEqual("notes");
});

test("parseAppSpec rejects component-local publish", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    publish:
      http:
        as: http-endpoint
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("schema");
  expect(err.validationPath).toEqual("$.components.web.publish");
});

test("parseAppSpec rejects legacy local listen.from", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      db:
        from: db.connection
        as: secret-env
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("schema");
  expect(err.validationPath).toEqual('$.components.web.listen."db".from');
});

test("parseAppSpec rejects connect output that is not a local component output ref", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    connect:
      identity:
        output: identity.primary.oidc
        inject: secret-env
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("connection-resolution");
  expect(err.validationPath).toEqual('$.components.web.connect."identity".output');
});

test("parseAppSpec rejects duplicate connect/listen binding names on one component", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  db:
    kind: postgres
  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: env
    listen:
      db:
        path: identity.primary.oidc
        inject: env
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("connection-resolution");
  expect(err.validationPath).toEqual('$.components.web.listen."db"');
});

test("parseAppSpec accepts platform listen path boundaries", () => {
  const maxSegment = "a".repeat(63);
  const exactly255Chars = [maxSegment, maxSegment, maxSegment, maxSegment].join(
    ".",
  );
  expect(exactly255Chars.length).toEqual(255);

  for (const path of ["a.b.c.d.e.f.g.h", exactly255Chars]) {
    const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      ext:
        path: ${path}
        inject: env
`);
    expect(spec.components.web.listen?.ext?.path).toEqual(path);
  }
});

test("parseAppSpec accepts discovery listen by material kind", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  agent:
    kind: worker
    listen:
      tools:
        kind: mcp-server@v1
        labels:
          capability: docs
        many: true
        inject: config-mount
`);

  expect(spec.components.agent.listen?.tools?.kind).toEqual("mcp-server@v1");
  expect(spec.components.agent.listen?.tools?.labels?.capability).toEqual("docs");
  expect(spec.components.agent.listen?.tools?.many).toEqual(true);
});

test("parseAppSpec accepts root publish without path for discovery", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
publish:
  tools:
    output: web.mcp
    kind: mcp-server@v1
    labels:
      capability: docs
`);

  expect(spec.publish?.tools?.output).toEqual("web.mcp");
  expect(spec.publish?.tools?.kind).toEqual("mcp-server@v1");
  expect(spec.publish?.tools?.path).toEqual(undefined);
  expect(spec.publish?.tools?.labels?.capability).toEqual("docs");
});

test("parseAppSpec rejects type as a component or material selector", () => {
  const component = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    type: worker
`),
    AppSpecParseError,
  );
  expect(component.validationPhase).toEqual("schema");
  expect(component.validationPath).toEqual("$.components.web.type");

  const listen = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      tools:
        type: mcp-server@v1
        many: true
        inject: config-mount
`),
    AppSpecParseError,
  );
  expect(listen.validationPhase).toEqual("schema");
  expect(listen.validationPath).toEqual('$.components.web.listen."tools".type');

  const publish = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
publish:
  tools:
    output: web.mcp
    type: mcp-server@v1
`),
    AppSpecParseError,
  );
  expect(publish.validationPhase).toEqual("schema");
  expect(publish.validationPath).toEqual('$.publish."tools".type');
});

test("parseAppSpec rejects malformed platform service paths", () => {
  const cases = [
    ["uppercase segment", "identity.Primary.oidc"],
    ["underscore segment", "identity.primary_oidc.service"],
    ["digit-first segment", "identity.1primary.oidc"],
    ["empty segment", "identity..oidc"],
    ["too many segments", "a.b.c.d.e.f.g.h.i"],
    ["two-segment local-looking path", "db.connection"],
  ] as const;

  for (const [name, path] of cases) {
    const err = assertThrows(
      () =>
        parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      service:
        path: ${JSON.stringify(path)}
        inject: env
`),
      AppSpecParseError,
      undefined,
      name,
    );
    expect(err.validationPhase).toEqual("connection-resolution");
    expect(err.validationPath).toEqual('$.components.web.listen."service".path');
  }
});

test("parseAppSpec rejects listen selectors without path or kind", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      service:
        inject: env
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("connection-resolution");
  expect(err.validationPath).toEqual('$.components.web.listen."service"');
});

test("parseAppSpec rejects many on exact listen path", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      service:
        path: identity.primary.oidc
        many: true
        inject: env
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("connection-resolution");
  expect(err.validationPath).toEqual('$.components.web.listen."service".many');
});

test("parseAppSpec rejects connect cycles and self loops", () => {
  const cycle = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: env
  db:
    kind: postgres
    connect:
      web:
        output: web.http
        inject: env
`),
    AppSpecParseError,
  );
  expect(cycle.validationPhase).toEqual("connection-resolution");

  const self = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    connect:
      self:
        output: web.http
        inject: env
`),
    AppSpecParseError,
  );
  expect(self.validationPhase).toEqual("connection-resolution");
  expect(self.validationPath).toEqual("$.components.web.connect.self.output");
});

test("parseAppSpec rejects root publish duplicate paths and unknown components", () => {
  const duplicate = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
publish:
  api:
    output: web.http
    path: acme.notes.api
  api-copy:
    output: web.http
    path: acme.notes.api
`),
    AppSpecParseError,
  );
  expect(duplicate.validationPhase).toEqual("connection-resolution");
  expect(duplicate.validationPath).toEqual('$.publish."api-copy".path');

  const unknown = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
publish:
  api:
    output: api.http
    path: acme.notes.api
`),
    AppSpecParseError,
  );
  expect(unknown.validationPhase).toEqual("connection-resolution");
  expect(unknown.validationPath).toEqual('$.publish."api".output');
});

test("parseAppSpec keeps kind opaque and rejects removed root/legacy fields", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  fn:
    kind: https://example.com/kinds/lambda
    spec:
      handler: index.handler
`);
  expect(spec.components.fn.kind).toEqual("https://example.com/kinds/lambda");

  const legacyUse = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    use:
      db: { env: DATABASE_URL }
`),
    AppSpecParseError,
  );
  expect(legacyUse.validationPhase).toEqual("legacy-use");

  const rootKind = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
kind: App
metadata: { id: x, name: y }
components: { web: { kind: worker } }
`),
    AppSpecParseError,
  );
  expect(rootKind.validationPath).toEqual("$.kind");
});

// --------------------------------------------------------------------------
// Hardening fixes (Agent 4)
// --------------------------------------------------------------------------

test("parseAppSpec rejects manifests larger than 1 MiB", () => {
  // Pad a valid manifest with a large YAML comment so the YAML stays
  // syntactically valid but the source byte length crosses the limit.
  const filler = "# " + "a".repeat(1024 * 1024) + "\n";
  const source = filler + `
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
`;
  const err = assertThrows(() => parseAppSpec(source), AppSpecParseError);
  expect(err.validationPhase).toEqual("manifest-too-large");
  expect(err.validationPath).toEqual("$");
});

test("parseAppSpec accepts manifests at or just under the 1 MiB limit", () => {
  // A valid manifest plus a comment block that keeps the total just
  // under the limit must parse cleanly.
  const valid = `
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
`;
  const headroom = 1024 * 1024 - new TextEncoder().encode(valid).byteLength -
    100;
  const filler = "# " + "a".repeat(headroom) + "\n";
  const spec = parseAppSpec(filler + valid);
  expect(spec.metadata.id).toEqual("x");
});

test("parseAppSpec rejects more than 256 components", () => {
  const lines = [
    "apiVersion: v1",
    "metadata: { id: x, name: y }",
    "components:",
  ];
  for (let i = 0; i < 257; i++) {
    lines.push(`  c${i}:`);
    lines.push("    kind: worker");
  }
  const err = assertThrows(
    () => parseAppSpec(lines.join("\n")),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("too-many-components");
  expect(err.validationPath).toEqual("$.components");
});

test("parseAppSpec accepts exactly 256 components", () => {
  const lines = [
    "apiVersion: v1",
    "metadata: { id: x, name: y }",
    "components:",
  ];
  for (let i = 0; i < 256; i++) {
    lines.push(`  c${i}:`);
    lines.push("    kind: worker");
  }
  const spec = parseAppSpec(lines.join("\n"));
  expect(Object.keys(spec.components).length).toEqual(256);
});

test("parseAppSpec rejects forbidden prototype-pollution keys in spec", () => {
  for (const forbidden of ["__proto__", "constructor", "prototype"]) {
    const err = assertThrows(
      () =>
        parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    spec:
      ${forbidden}:
        polluted: true
`),
      AppSpecParseError,
    );
    expect(err.validationPhase).toEqual("forbidden-field");
  }
});

test("parseAppSpec rejects forbidden keys nested deep inside spec", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    spec:
      env:
        nested:
          __proto__:
            polluted: true
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("forbidden-field");
  expect(err.validationPath).toEqual("$.components.web.spec.env.nested.__proto__");
});

test("parseAppSpec rejects forbidden keys inside spec arrays", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    spec:
      items:
        - normal: true
        - __proto__:
            polluted: true
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("forbidden-field");
});

test("parseAppSpec accepts relaxed reverse-DNS metadata ids", () => {
  for (
    const id of [
      "x",
      "com.example",
      "com.example.notes",
      "com.example.team.notes.app",
      "a-b.c-d.e-f",
    ]
  ) {
    const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: ${id}, name: y }
components:
  web:
    kind: worker
`);
    expect(spec.metadata.id).toEqual(id);
  }
});

test("parseAppSpec rejects metadata ids that fail the reverse-DNS pattern", () => {
  // YAML cannot embed bare control characters, but uppercase / digit-first /
  // 6-segment / trailing-dot variants must all be rejected.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["uppercase", "Com.Example"],
    ["digit-first", "1com.example"],
    ["empty segment", "com..example"],
    ["trailing dot", "com.example."],
    ["leading dot", ".com.example"],
    ["too many segments", "a.b.c.d.e.f"],
    ["underscore", "com.example_app"],
    ["whitespace", "com example"],
  ];
  for (const [name, id] of cases) {
    const err = assertThrows(
      () =>
        parseAppSpec(`
apiVersion: v1
metadata: { id: ${JSON.stringify(id)}, name: y }
components:
  web:
    kind: worker
`),
      AppSpecParseError,
      undefined,
      name,
    );
    expect(err.validationPhase).toEqual("invalid-metadata-id");
    expect(err.validationPath).toEqual("$.metadata.id");
  }
});

test("parseAppSpec rejects metadata ids containing control characters", () => {
  // Inject NUL / tab / DEL via double-quoted YAML escapes so the YAML
  // lexer accepts the value but the parser then rejects it with
  // `invalid_metadata_id`. The relaxed reverse-DNS regex would already
  // reject these inputs; the explicit control-char check produces a
  // clearer diagnostic.
  for (const escape of ["\\u0000", "\\t", "\\u0001", "\\u007f"]) {
    const yaml =
      `apiVersion: v1\nmetadata:\n  id: "com.example${escape}app"\n  name: y\ncomponents:\n  web:\n    kind: worker\n`;
    const err = assertThrows(
      () => parseAppSpec(yaml),
      AppSpecParseError,
      undefined,
      escape,
    );
    expect(err.validationPhase).toEqual("invalid-metadata-id");
    expect(err.validationPath).toEqual("$.metadata.id");
  }
});

test("parseAppSpec rejects manifests with raw NUL via YAML syntax error", () => {
  // YAML 1.2 forbids unescaped C0 control characters in scalars
  // (other than tab/LF/CR), so a manifest with a raw NUL is rejected
  // by the YAML lexer before the parser sees it. We still want to
  // verify that the closed envelope reports `syntax` here so
  // operators get a clear diagnostic.
  const yaml =
    `apiVersion: v1\nmetadata: { id: "com.\u0000example", name: y }\ncomponents:\n  web:\n    kind: worker\n`;
  const err = assertThrows(() => parseAppSpec(yaml), AppSpecParseError);
  expect(err.validationPhase).toEqual("syntax");
});

test("parseAppSpec accepts https / http homepage URLs", () => {
  for (const homepage of ["https://example.com", "http://example.test"]) {
    const spec = parseAppSpec(`
apiVersion: v1
metadata:
  id: com.example.app
  name: y
  homepage: ${JSON.stringify(homepage)}
components:
  web:
    kind: worker
`);
    expect(spec.metadata.homepage).toEqual(homepage);
  }
});

test("parseAppSpec rejects dangerous homepage URL schemes", () => {
  for (
    const homepage of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com",
      "not a url at all",
    ]
  ) {
    const err = assertThrows(
      () =>
        parseAppSpec(`
apiVersion: v1
metadata:
  id: com.example.app
  name: y
  homepage: ${JSON.stringify(homepage)}
components:
  web:
    kind: worker
`),
      AppSpecParseError,
      undefined,
      homepage,
    );
    expect(err.validationPhase).toEqual("invalid-metadata-homepage");
    expect(err.validationPath).toEqual("$.metadata.homepage");
  }
});

test("parseAppSpec rejects reserved platform service path prefixes on listen", () => {
  for (
    const reserved of ["takosumi.core.lifecycle", "system.metrics.endpoint"]
  ) {
    const err = assertThrows(
      () =>
        parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      svc:
        path: ${JSON.stringify(reserved)}
        inject: env
`),
      AppSpecParseError,
      undefined,
      reserved,
    );
    expect(err.validationPhase).toEqual("connection-resolution");
    expect(err.validationPath).toEqual('$.components.web.listen."svc".path');
  }
});

test("parseAppSpec rejects reserved platform service path prefixes on root publish", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
publish:
  bad:
    output: web.http
    path: takosumi.lifecycle.events
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("connection-resolution");
  expect(err.validationPath).toEqual('$.publish."bad".path');
});

test("parseAppSpec iterative cycle detector handles deep but legal connect chains", () => {
  const depth = 256;
  const lines = [
    "apiVersion: v1",
    "metadata: { id: x, name: y }",
    "components:",
  ];
  for (let i = 0; i < depth; i++) {
    lines.push(`  a${i}:`);
    lines.push("    kind: worker");
    if (i + 1 < depth) {
      lines.push("    connect:");
      lines.push("      down:");
      lines.push(`        output: a${i + 1}.http`);
      lines.push("        inject: env");
    }
  }
  const spec = parseAppSpec(lines.join("\n"));
  expect(Object.keys(spec.components).length).toEqual(depth);
});

test("parseAppSpec iterative detector still rejects long cycles", () => {
  // Build a256 → a0 to create a cycle that covers the full chain.
  const depth = 256;
  const lines = [
    "apiVersion: v1",
    "metadata: { id: x, name: y }",
    "components:",
  ];
  for (let i = 0; i < depth; i++) {
    lines.push(`  a${i}:`);
    lines.push("    kind: worker");
    lines.push("    connect:");
    lines.push("      down:");
    lines.push(`        output: a${(i + 1) % depth}.http`);
    lines.push("        inject: env");
  }
  const err = assertThrows(
    () => parseAppSpec(lines.join("\n")),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("connection-resolution");
});

test("parseAppSpec warns on unknown listen inject shape but accepts it", () => {
  const warnings: Array<{ message: string; path: string }> = [];
  const logger: AppSpecParseLogger = {
    warn(message: string, path: string) {
      warnings.push({ message, path });
    },
  };
  const spec = parseAppSpec(
    `
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      svc:
        path: identity.primary.oidc
        inject: operator-shape-xyz
`,
    { logger },
  );
  expect(spec.components.web.listen?.svc?.inject).toEqual("operator-shape-xyz");
  expect(warnings.length).toEqual(1);
  expect(warnings[0]!.path).toEqual('$.components.web.listen."svc".inject');
});

test("parseAppSpec stays silent on known listen inject shapes", () => {
  const warnings: Array<{ message: string; path: string }> = [];
  const logger: AppSpecParseLogger = {
    warn(message: string, path: string) {
      warnings.push({ message, path });
    },
  };
  for (const shape of KNOWN_LISTEN_SHAPES) {
    parseAppSpec(
      `
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      svc:
        path: identity.primary.oidc
        inject: ${shape}
`,
      { logger },
    );
  }
  expect(warnings.length).toEqual(0);
});

test("parseAppSpec does not warn on open-vocabulary listen.kind", () => {
  // Regression: listen.kind is a discovered material KIND, not an inject
  // SHAPE. It must not be compared against KNOWN_LISTEN_SHAPES (which would
  // warn for essentially every legitimate kind such as `mcp-server@v1`).
  const warnings: Array<{ message: string; path: string }> = [];
  const logger: AppSpecParseLogger = {
    warn(message: string, path: string) {
      warnings.push({ message, path });
    },
  };
  parseAppSpec(
    `
apiVersion: v1
metadata: { id: x, name: y }
components:
  agent:
    kind: worker
    listen:
      tools:
        kind: mcp-server@v1
        inject: config-mount
`,
    { logger },
  );
  expect(warnings.length).toEqual(0);
});

test("parseAppSpec rejects inject values that conflict with KNOWN_LISTEN_SHAPES typing", () => {
  for (const bad of ["bad shape", "with\ttab", "with\u0000nul"]) {
    const err = assertThrows(
      () =>
        parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      svc:
        path: identity.primary.oidc
        inject: ${JSON.stringify(bad)}
`),
      AppSpecParseError,
      undefined,
      bad,
    );
    expect(err.validationPhase).toEqual("connection-resolution");
    expect(err.validationPath).toEqual('$.components.web.listen."svc".inject');
  }
});

test("parseAppSpec also validates connect inject typing", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  db:
    kind: postgres
  web:
    kind: worker
    connect:
      db:
        output: db.connection
        inject: "with whitespace"
`),
    AppSpecParseError,
  );
  expect(err.validationPhase).toEqual("connection-resolution");
  expect(err.validationPath).toEqual('$.components.web.connect."db".inject');
});
