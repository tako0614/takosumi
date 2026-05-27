import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.5";
import { AppSpecParseError, parseAppSpec } from "./yaml-parser.ts";

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
