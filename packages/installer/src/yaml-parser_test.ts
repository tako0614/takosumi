import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.5";
import { AppSpecParseError, parseAppSpec } from "./yaml-parser.ts";

Deno.test("parseAppSpec — canonical worker + db example with publish/listen", () => {
  const yaml = `
apiVersion: takosumi.dev/v1

metadata:
  id: com.example.notes
  name: Example Notes
  publisher: example

components:
  web:
    kind: worker
    build:
      command: npm ci && npm run build
      output: dist/worker.mjs
    spec:
      routes:
        - /
    publish:
      - com.example.notes.web
    listen:
      com.example.notes.db:
        as: env
        prefix: DB

  db:
    kind: postgres
    publish:
      - com.example.notes.db
`;
  const spec = parseAppSpec(yaml);
  assertEquals(spec.apiVersion, "takosumi.dev/v1");
  assertEquals(spec.metadata.id, "com.example.notes");
  assertEquals(Object.keys(spec.components).sort(), ["db", "web"]);
  assertEquals(spec.components.web.kind, "worker");
  assertEquals(spec.components.web.build?.command, "npm ci && npm run build");
  assertEquals(spec.components.web.publish, ["com.example.notes.web"]);
  assertEquals(
    spec.components.web.listen?.["com.example.notes.db"]?.as,
    "env",
  );
  assertEquals(
    spec.components.web.listen?.["com.example.notes.db"]?.prefix,
    "DB",
  );
  // routes lives inside the worker kind's open `spec` field — not a
  // top-level Component field. The materializer reads `spec.routes`
  // by convention; the AppSpec contract stays kind-agnostic.
  assertEquals(
    (spec.components.web.spec as { routes?: readonly string[] }).routes,
    ["/"],
  );
  assertEquals(spec.components.db.kind, "postgres");
  assertEquals(spec.components.db.publish, ["com.example.notes.db"]);
});

Deno.test("parseAppSpec rejects top-level Component `routes:` (= moved into spec.routes)", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    routes: ["/"]
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.components.web.routes");
});

Deno.test("parseAppSpec rejects top-level `interfaces:` (= no longer in AppSpec contract)", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
interfaces:
  launch: { target: web, path: / }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.interfaces");
});

Deno.test("parseAppSpec rejects top-level `permissions:` (= no longer in AppSpec contract)", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
permissions:
  requested: ["logs.read.own"]
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.permissions");
});

Deno.test("parseAppSpec rejects unknown top-level field", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components: { web: { kind: worker, build: { command: x, output: y } } }
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
components: { web: { kind: worker, build: { command: x, output: y } } }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPath, "$.apiVersion");
});

Deno.test("parseAppSpec rejects unknown kind in component", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: not-a-kind
    build: { command: x, output: y }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "kind-catalog");
});

Deno.test("parseAppSpec rejects legacy `use:` field with legacy-use phase", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
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
  // web publishes X, db listens X and publishes Y, web listens Y → cycle.
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    publish:
      - com.example.notes.web
    listen:
      com.example.notes.db:
        as: env
        prefix: DB
  db:
    kind: postgres
    publish:
      - com.example.notes.db
    listen:
      com.example.notes.web:
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
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    publish:
      - com.example.notes.web
    listen:
      com.example.notes.web:
        as: env
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects duplicate namespace publisher across components", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  a:
    kind: worker
    build: { command: x, output: y }
    publish:
      - com.example.shared
  b:
    kind: worker
    build: { command: x, output: y }
    publish:
      - com.example.shared
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects malformed namespace path in publish", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    publish:
      - "com..example.bad"
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects listen entry without `as` field", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    listen:
      com.example.x: {}
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "publish-listen");
});

Deno.test("parseAppSpec rejects listen entry with unknown option key", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    listen:
      com.example.x:
        as: env
        unexpected: true
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
});

Deno.test("parseAppSpec accepts built-in kind canonical URI", () => {
  const spec = parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: https://takosumi.com/kinds/v1/worker
    build: { command: x, output: y }
`);
  assertEquals(
    spec.components.web.kind,
    "https://takosumi.com/kinds/v1/worker",
  );
});

Deno.test("parseAppSpec accepts operator-defined kind URI", () => {
  const spec = parseAppSpec(`
apiVersion: takosumi.dev/v1
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

Deno.test("parseAppSpec accepts operator-defined listen shapes (forward compat)", () => {
  // The parser MUST NOT enforce a closed set of `as` values — operator
  // materializers can declare their own shapes (e.g. "grpc-service").
  const spec = parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    listen:
      com.example.svc:
        as: grpc-service
`);
  assertEquals(
    spec.components.web.listen?.["com.example.svc"]?.as,
    "grpc-service",
  );
});

Deno.test("parseAppSpec rejects non-URI / non-short-name kind", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: not-a-kind-and-not-a-uri
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "kind-catalog");
});

Deno.test("parseAppSpec allows listen to external publisher (no AppSpec edge)", () => {
  // Listening to a path no AppSpec component publishes is permitted —
  // an external system (e.g. Takosumi Accounts) may publish to that
  // path at install time. The parser does not enforce internal
  // publisher existence.
  const spec = parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    listen:
      takosumi-accounts.com.example.notes.oidc:
        as: env
        prefix: OIDC
`);
  assertEquals(
    spec.components.web.listen?.["takosumi-accounts.com.example.notes.oidc"]
      ?.as,
    "env",
  );
});

Deno.test("parseAppSpec rejects root `kind:` field (= Wave K AppSpec envelope minimization)", () => {
  // Wave K: AppSpec root collapsed from 4 fields to 3
  // (`{ apiVersion, metadata, components }`). The `kind: App` field at
  // the root is no longer accepted — apiVersion alone discriminates the
  // schema. Authors who keep `kind:` get an unknown-key reject
  // (`validationPhase: "schema"`, `$.kind`).
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
metadata: { id: x, name: y }
components: { web: { kind: worker, build: { command: x, output: y } } }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "schema");
  assertEquals(err.validationPath, "$.kind");
});

Deno.test("parseAppSpec accepts root without `kind:` field (= Wave K minimal envelope)", () => {
  // Wave K canonical envelope: `apiVersion` + `metadata` + `components`.
  const spec = parseAppSpec(`
apiVersion: takosumi.dev/v1
metadata: { id: com.example.minimal, name: Minimal }
components:
  web:
    kind: worker
    build: { command: x, output: y }
`);
  assertEquals(spec.apiVersion, "takosumi.dev/v1");
  assertEquals(spec.metadata.id, "com.example.minimal");
  assertEquals(spec.components.web.kind, "worker");
});
