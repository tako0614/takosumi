import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.5";
import { AppSpecParseError, parseAppSpec } from "./yaml-parser.ts";

Deno.test("parseAppSpec accepts canonical worker + db + gateway example", () => {
  const yaml = `
apiVersion: v1

metadata:
  id: com.example.notes
  name: Example Notes
  publisher: example

components:
  db:
    kind: postgres
    publish:
      connection:
        as: service-binding

  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
    listen:
      db:
        from: db.connection
        as: env
        prefix: DB
    publish:
      http:
        as: http-endpoint

  public:
    kind: gateway
    listen:
      app:
        from: web.http
        as: upstream
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
`;
  const spec = parseAppSpec(yaml);
  assertEquals(spec.apiVersion, "v1");
  assertEquals(spec.metadata.id, "com.example.notes");
  assertEquals(Object.keys(spec.components).sort(), ["db", "public", "web"]);
  assertEquals(spec.components.db.publish?.connection?.as, "service-binding");
  assertEquals(spec.components.web.listen?.db?.from, "db.connection");
  assertEquals(spec.components.web.publish?.http?.as, "http-endpoint");
  assertEquals(spec.components.public.listen?.app?.as, "upstream");
});

Deno.test("parseAppSpec rejects top-level Component `routes:` (= routes live in kind spec)", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    routes: ["/"]
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.components.web.routes");
});

Deno.test("parseAppSpec rejects Component `build:` (= build lives outside AppSpec)", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.components.web.build");
});

Deno.test("parseAppSpec rejects removed root fields", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
interfaces:
  launch: { target: web, path: / }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.interfaces");
});

Deno.test("parseAppSpec rejects unknown top-level field", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components: { web: { kind: worker } }
extraField: nope
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
});

Deno.test("parseAppSpec rejects invalid apiVersion", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: "1.0"
metadata: { id: x, name: y }
components: { web: { kind: worker } }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPath, "$.apiVersion");
});

Deno.test("parseAppSpec accepts arbitrary bare component kind alias", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: not-a-kind
`);
  assertEquals(spec.components.web.kind, "not-a-kind");
});

Deno.test("parseAppSpec rejects legacy `use:` field with legacy-use phase", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    use:
      db: { env: DATABASE_URL }
  db:
    kind: postgres
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "legacy-use");
  assertEquals(err.validationPath, "$.components.web.use");
});

Deno.test("parseAppSpec detects publish/listen cycle", () => {
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
    listen:
      db:
        from: db.connection
        as: env
        prefix: DB
  db:
    kind: postgres
    publish:
      connection:
        as: service-binding
    listen:
      web:
        from: web.http
        as: env
        prefix: WEB
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects self-loop in publish/listen", () => {
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
    listen:
      self:
        from: web.http
        as: env
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects old string-list publish", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    publish:
      - com.example.shared
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.components.web.publish");
});

Deno.test("parseAppSpec rejects malformed publication name", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    publish:
      "bad.name":
        as: http-endpoint
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
});

Deno.test("parseAppSpec rejects publish output selectors", () => {
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
        from: url
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, '$.components.web.publish."http".from');
});

Deno.test("parseAppSpec rejects listen entry without `from` field", () => {
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
        as: env
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects listen entry without `as` field", () => {
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
        from: database.connection
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects listen entry with unknown option key", () => {
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
        from: database.connection
        as: env
        unexpected: true
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
});

Deno.test("parseAppSpec rejects unknown local listen source", () => {
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
        as: env
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects bare external namespace path in listen source", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      oidc:
        from: operator.identity.oidc
        as: env
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec accepts optional external namespace source", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      oidc:
        from: namespace:operator.identity.oidc
        as: env
        prefix: OIDC
`);
  assertEquals(
    spec.components.web.listen?.oidc?.from,
    "namespace:operator.identity.oidc",
  );
  assertEquals(spec.components.web.listen?.oidc?.required, undefined);
});

Deno.test("parseAppSpec accepts required external namespace source", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      oidc:
        from: namespace:operator.identity.oidc
        as: env
        prefix: OIDC
        required: true
`);
  assertEquals(spec.components.web.listen?.oidc?.required, true);
});

Deno.test("parseAppSpec rejects non-boolean listen required", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    listen:
      oidc:
        from: namespace:operator.identity.oidc
        as: env
        required: "yes"
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
  assertEquals(err.validationPath, '$.components.web.listen."oidc".required');
});

Deno.test("parseAppSpec accepts operator-defined listen shapes", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  svc:
    kind: service
    publish:
      grpc:
        as: grpc-service
  web:
    kind: worker
    listen:
      api:
        from: svc.grpc
        as: grpc-client
`);
  assertEquals(spec.components.web.listen?.api?.as, "grpc-client");
});

Deno.test("parseAppSpec accepts reference kind URI as opaque string", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: https://takosumi.com/kinds/v1/worker
`);
  assertEquals(
    spec.components.web.kind,
    "https://takosumi.com/kinds/v1/worker",
  );
});

Deno.test("parseAppSpec accepts operator-defined kind URI", () => {
  const spec = parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  fn:
    kind: https://operator.example.com/kinds/lambda
    spec:
      handler: index.handler
`);
  assertEquals(
    spec.components.fn.kind,
    "https://operator.example.com/kinds/lambda",
  );
});

Deno.test("parseAppSpec rejects scalar component spec", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  fn:
    kind: https://operator.example.com/kinds/lambda
    spec: index.handler
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.components.fn.spec");
});

Deno.test("parseAppSpec rejects array component spec", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  fn:
    kind: https://operator.example.com/kinds/lambda
    spec:
      - handler: index.handler
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.components.fn.spec");
});

Deno.test("parseAppSpec rejects empty component kind", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
metadata: { id: x, name: y }
components:
  web:
    kind: ""
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "kind-catalog");
});

Deno.test("parseAppSpec rejects root `kind:` field (= minimal envelope)", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: v1
kind: App
metadata: { id: x, name: y }
components: { web: { kind: worker } }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.kind");
});

Deno.test("parseAppSpec rejects legacy `apiVersion: takosumi.dev/v1`", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components: { web: { kind: worker } }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.apiVersion");
});
