import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.5";
import {
  AppSpecParseError,
  type AppSpecParseLogger,
  KNOWN_LISTEN_SHAPES,
  parseAppSpec,
} from "./yaml-parser.ts";

Deno.test("parseAppSpec accepts canonical connect + platform listen + root publish example", () => {
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

  assertEquals(spec.apiVersion, "v1");
  assertEquals(spec.components.web.connect?.db?.output, "db.connection");
  assertEquals(spec.components.web.connect?.db?.inject, "secret-env");
  assertEquals(
    spec.components.web.listen?.identity?.path,
    "identity.primary.oidc",
  );
  assertEquals(spec.components.public.connect?.app?.inject, "upstream");
  assertEquals(spec.publish?.api?.output, "web.http");
  assertEquals(spec.publish?.api?.kind, "http-endpoint");
  assertEquals(spec.publish?.api?.path, "acme.notes.api");
  assertEquals(spec.publish?.api?.labels?.app, "notes");
});

Deno.test("parseAppSpec rejects component-local publish", () => {
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
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.components.web.publish");
});

Deno.test("parseAppSpec rejects legacy local listen.from", () => {
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
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, '$.components.web.listen."db".from');
});

Deno.test("parseAppSpec rejects connect output that is not a local component output ref", () => {
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
  assertEquals(err.validationPhase, "connection-resolution");
  assertEquals(
    err.validationPath,
    '$.components.web.connect."identity".output',
  );
});

Deno.test("parseAppSpec accepts platform listen path boundaries", () => {
  const maxSegment = "a".repeat(63);
  const exactly255Chars = [maxSegment, maxSegment, maxSegment, maxSegment].join(
    ".",
  );
  assertEquals(exactly255Chars.length, 255);

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
    assertEquals(spec.components.web.listen?.ext?.path, path);
  }
});

Deno.test("parseAppSpec accepts discovery listen by material kind", () => {
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

  assertEquals(spec.components.agent.listen?.tools?.kind, "mcp-server@v1");
  assertEquals(
    spec.components.agent.listen?.tools?.labels?.capability,
    "docs",
  );
  assertEquals(spec.components.agent.listen?.tools?.many, true);
});

Deno.test("parseAppSpec accepts root publish without path for discovery", () => {
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

  assertEquals(spec.publish?.tools?.output, "web.mcp");
  assertEquals(spec.publish?.tools?.kind, "mcp-server@v1");
  assertEquals(spec.publish?.tools?.path, undefined);
  assertEquals(spec.publish?.tools?.labels?.capability, "docs");
});

Deno.test("parseAppSpec rejects type as a component or material selector", () => {
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
  assertEquals(component.validationPhase, "schema");
  assertEquals(component.validationPath, "$.components.web.type");

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
  assertEquals(listen.validationPhase, "schema");
  assertEquals(listen.validationPath, '$.components.web.listen."tools".type');

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
  assertEquals(publish.validationPhase, "schema");
  assertEquals(publish.validationPath, '$.publish."tools".type');
});

Deno.test("parseAppSpec rejects malformed platform service paths", () => {
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
    assertEquals(err.validationPhase, "connection-resolution", name);
    assertEquals(
      err.validationPath,
      '$.components.web.listen."service".path',
      name,
    );
  }
});

Deno.test("parseAppSpec rejects listen selectors without path or kind", () => {
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
  assertEquals(err.validationPhase, "connection-resolution");
  assertEquals(err.validationPath, '$.components.web.listen."service"');
});

Deno.test("parseAppSpec rejects many on exact listen path", () => {
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
  assertEquals(err.validationPhase, "connection-resolution");
  assertEquals(err.validationPath, '$.components.web.listen."service".many');
});

Deno.test("parseAppSpec rejects connect cycles and self loops", () => {
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
  assertEquals(cycle.validationPhase, "connection-resolution");

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
  assertEquals(self.validationPhase, "connection-resolution");
  assertEquals(self.validationPath, "$.components.web.connect.self.output");
});

Deno.test("parseAppSpec rejects root publish duplicate paths and unknown components", () => {
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
  assertEquals(duplicate.validationPhase, "connection-resolution");
  assertEquals(duplicate.validationPath, '$.publish."api-copy".path');

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
  assertEquals(unknown.validationPhase, "connection-resolution");
  assertEquals(unknown.validationPath, '$.publish."api".output');
});

Deno.test("parseAppSpec keeps kind opaque and rejects removed root/legacy fields", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  fn:
    kind: https://example.com/kinds/lambda
    spec:
      handler: index.handler
`);
  assertEquals(
    spec.components.fn.kind,
    "https://example.com/kinds/lambda",
  );

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
  assertEquals(legacyUse.validationPhase, "legacy-use");

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
  assertEquals(rootKind.validationPath, "$.kind");
});

// --------------------------------------------------------------------------
// Hardening fixes (Agent 4)
// --------------------------------------------------------------------------

Deno.test("parseAppSpec rejects manifests larger than 1 MiB", () => {
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
  assertEquals(err.validationPhase, "manifest-too-large");
  assertEquals(err.validationPath, "$");
});

Deno.test("parseAppSpec accepts manifests at or just under the 1 MiB limit", () => {
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
  assertEquals(spec.metadata.id, "x");
});

Deno.test("parseAppSpec rejects more than 256 components", () => {
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
  assertEquals(err.validationPhase, "too-many-components");
  assertEquals(err.validationPath, "$.components");
});

Deno.test("parseAppSpec accepts exactly 256 components", () => {
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
  assertEquals(Object.keys(spec.components).length, 256);
});

Deno.test("parseAppSpec rejects forbidden prototype-pollution keys in spec", () => {
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
    assertEquals(err.validationPhase, "forbidden-field", forbidden);
  }
});

Deno.test("parseAppSpec rejects forbidden keys nested deep inside spec", () => {
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
  assertEquals(err.validationPhase, "forbidden-field");
  assertEquals(
    err.validationPath,
    "$.components.web.spec.env.nested.__proto__",
  );
});

Deno.test("parseAppSpec rejects forbidden keys inside spec arrays", () => {
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
  assertEquals(err.validationPhase, "forbidden-field");
});

Deno.test("parseAppSpec accepts relaxed reverse-DNS metadata ids", () => {
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
    assertEquals(spec.metadata.id, id);
  }
});

Deno.test("parseAppSpec rejects metadata ids that fail the reverse-DNS pattern", () => {
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
    assertEquals(err.validationPhase, "invalid-metadata-id", name);
    assertEquals(err.validationPath, "$.metadata.id", name);
  }
});

Deno.test("parseAppSpec rejects metadata ids containing control characters", () => {
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
    assertEquals(err.validationPhase, "invalid-metadata-id", escape);
    assertEquals(err.validationPath, "$.metadata.id", escape);
  }
});

Deno.test("parseAppSpec rejects manifests with raw NUL via YAML syntax error", () => {
  // YAML 1.2 forbids unescaped C0 control characters in scalars
  // (other than tab/LF/CR), so a manifest with a raw NUL is rejected
  // by the YAML lexer before the parser sees it. We still want to
  // verify that the closed envelope reports `syntax` here so
  // operators get a clear diagnostic.
  const yaml =
    `apiVersion: v1\nmetadata: { id: "com.\u0000example", name: y }\ncomponents:\n  web:\n    kind: worker\n`;
  const err = assertThrows(() => parseAppSpec(yaml), AppSpecParseError);
  assertEquals(err.validationPhase, "syntax");
});

Deno.test("parseAppSpec accepts https / http homepage URLs", () => {
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
    assertEquals(spec.metadata.homepage, homepage);
  }
});

Deno.test("parseAppSpec rejects dangerous homepage URL schemes", () => {
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
    assertEquals(err.validationPhase, "invalid-metadata-homepage", homepage);
    assertEquals(err.validationPath, "$.metadata.homepage", homepage);
  }
});

Deno.test("parseAppSpec rejects reserved platform service path prefixes on listen", () => {
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
    assertEquals(err.validationPhase, "connection-resolution", reserved);
    assertEquals(
      err.validationPath,
      '$.components.web.listen."svc".path',
      reserved,
    );
  }
});

Deno.test("parseAppSpec rejects reserved platform service path prefixes on root publish", () => {
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
  assertEquals(err.validationPhase, "connection-resolution");
  assertEquals(err.validationPath, '$.publish."bad".path');
});

Deno.test("parseAppSpec iterative cycle detector handles deep but legal connect chains", () => {
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
  assertEquals(Object.keys(spec.components).length, depth);
});

Deno.test("parseAppSpec iterative detector still rejects long cycles", () => {
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
  assertEquals(err.validationPhase, "connection-resolution");
});

Deno.test("parseAppSpec warns on unknown listen inject shape but accepts it", () => {
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
  assertEquals(spec.components.web.listen?.svc?.inject, "operator-shape-xyz");
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0]!.path, '$.components.web.listen."svc".inject');
});

Deno.test("parseAppSpec stays silent on known listen inject shapes", () => {
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
  assertEquals(warnings.length, 0);
});

Deno.test("parseAppSpec rejects inject values that conflict with KNOWN_LISTEN_SHAPES typing", () => {
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
    assertEquals(err.validationPhase, "connection-resolution", bad);
    assertEquals(
      err.validationPath,
      '$.components.web.listen."svc".inject',
      bad,
    );
  }
});

Deno.test("parseAppSpec also validates connect inject typing", () => {
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
  assertEquals(err.validationPhase, "connection-resolution");
  assertEquals(err.validationPath, '$.components.web.connect."db".inject');
});
