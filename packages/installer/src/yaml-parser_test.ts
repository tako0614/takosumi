import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.5";
import { AppSpecParseError, parseAppSpec } from "./yaml-parser.ts";

Deno.test("parseAppSpec — canonical worker + db + oidc example", () => {
  const yaml = `
apiVersion: takosumi.dev/v1
kind: App

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
    routes:
      - /
    use:
      db:
        env: DATABASE_URL
      auth:
        mount: oidc

  db:
    kind: postgres

  auth:
    kind: oidc
    redirectPaths:
      - /api/auth/callback
    scopes:
      - openid
      - profile

interfaces:
  launch:
    target: web
    path: /api/auth/launch

permissions:
  requested:
    - logs.read.own
`;
  const spec = parseAppSpec(yaml);
  assertEquals(spec.apiVersion, "takosumi.dev/v1");
  assertEquals(spec.kind, "App");
  assertEquals(spec.metadata.id, "com.example.notes");
  assertEquals(Object.keys(spec.components).sort(), ["auth", "db", "web"]);
  assertEquals(spec.components.web.kind, "worker");
  assertEquals(spec.components.web.build?.command, "npm ci && npm run build");
  assertEquals(spec.components.web.use?.db.env, "DATABASE_URL");
  assertEquals(spec.components.web.use?.auth.mount, "oidc");
  assertEquals(spec.components.db.kind, "postgres");
  assertEquals(spec.interfaces?.launch?.path, "/api/auth/launch");
  assertEquals(spec.permissions?.requested, ["logs.read.own"]);
});

Deno.test("parseAppSpec rejects unknown top-level field", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
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
kind: App
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
kind: App
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

Deno.test("parseAppSpec detects use-edge cycle", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    use:
      db: { env: DATABASE_URL }
  db:
    kind: postgres
    use:
      web: { env: WEB_URL }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "use-edge");
});

Deno.test("parseAppSpec rejects mount=oidc on non-oidc target", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    use:
      db: { mount: oidc }
  db:
    kind: postgres
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "use-edge");
});

Deno.test("parseAppSpec rejects use-edge to unknown component", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    use:
      ghost: { env: GHOST_URL }
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "use-edge");
});

Deno.test("parseAppSpec accepts built-in kind canonical URI", () => {
  const spec = parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
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
kind: App
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

Deno.test("parseAppSpec preserves mount=oidc check via canonical URI", () => {
  // The target component declares `kind` via the canonical URI of the
  // built-in `oidc` kind; mount=oidc must still resolve.
  const spec = parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    use:
      auth:
        mount: oidc
  auth:
    kind: https://takosumi.com/kinds/v1/oidc
    redirectPaths: [/cb]
    scopes: [openid]
`);
  assertEquals(
    spec.components.auth.kind,
    "https://takosumi.com/kinds/v1/oidc",
  );
});

Deno.test("parseAppSpec rejects mount=oidc on operator-defined non-oidc kind", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
metadata: { id: x, name: y }
components:
  web:
    kind: worker
    build: { command: x, output: y }
    use:
      auth:
        mount: oidc
  auth:
    kind: https://operator.example.com/kinds/not-oidc
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "use-edge");
});

Deno.test("parseAppSpec rejects non-URI / non-short-name kind", () => {
  const err = assertThrows(
    () =>
      parseAppSpec(`
apiVersion: takosumi.dev/v1
kind: App
metadata: { id: x, name: y }
components:
  web:
    kind: not-a-kind-and-not-a-uri
`),
    AppSpecParseError,
  );
  assertEquals(err.validationPhase, "kind-catalog");
});
