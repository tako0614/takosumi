import { assertEquals } from "jsr:@std/assert@^1.0.6";
import type { ShapeValidationIssue } from "takosumi-contract/reference/shape";
import { GatewayKind } from "./gateway.ts";

Deno.test("GatewayKind rejects routes pointing at undeclared listeners", () => {
  const issues = validate({
    listeners: {
      public: { protocol: "https" },
    },
    routes: [{
      listener: "admin",
      path: "/",
      to: "app",
    }],
  });

  assertEquals(issues, [{
    path: "$.routes[0].listener",
    message: "must reference a listener declared in $.listeners",
  }]);
});

Deno.test("GatewayKind rejects duplicate listener/path routes", () => {
  const issues = validate({
    listeners: {
      public: { protocol: "https" },
    },
    routes: [
      { listener: "public", path: "/api", to: "api" },
      { listener: "public", path: "/api", to: "api-v2" },
    ],
  });

  assertEquals(issues, [{
    path: "$.routes[1]",
    message: "duplicates $.routes[0] for listener/path public /api",
  }]);
});

Deno.test("GatewayKind rejects path-changing dot segments", () => {
  const issues = validate({
    listeners: {
      public: { protocol: "https" },
    },
    routes: [
      { listener: "public", path: "/api/../admin", to: "app" },
      { listener: "public", path: "/api/%2e%2e/admin", to: "app" },
      { listener: "public", path: "/api/%252e%252e/admin", to: "app" },
      { listener: "public", path: "/api/%2E/admin", to: "app" },
      { listener: "public", path: "/api/\u0000/admin", to: "app" },
    ],
  });

  assertEquals(issues, [
    {
      path: "$.routes[0].path",
      message: "must not contain raw or percent-encoded dot segments",
    },
    {
      path: "$.routes[1].path",
      message: "must not contain raw or percent-encoded dot segments",
    },
    // Double-encoded `..`: a proxy that percent-decodes twice resolves
    // `%252e%252e` -> `%2e%2e` -> `..`, so it must be rejected too.
    {
      path: "$.routes[2].path",
      message: "must not contain raw or percent-encoded dot segments",
    },
    // Mixed-case single-encoded `.` segment (`%2E`).
    {
      path: "$.routes[3].path",
      message: "must not contain raw or percent-encoded dot segments",
    },
    {
      path: "$.routes[4].path",
      message: 'must be a path beginning with "/" and contain no ?, #, or NUL',
    },
  ]);
});

Deno.test("GatewayKind accepts case-differing but coherent host outputs", () => {
  const issues: ShapeValidationIssue[] = [];
  GatewayKind.validateOutputs({
    url: "https://app.example.test",
    // Mixed-case host: DNS is case-insensitive, so this matches the
    // lowercased url.hostname and must not be flagged.
    host: "App.Example.Test",
    scheme: "https",
    listener: "public",
    routes: [{ pathPrefix: "/", to: "app" }],
  }, issues);

  assertEquals(issues, []);
});

Deno.test("GatewayKind rejects incoherent public endpoint outputs", () => {
  const issues: ShapeValidationIssue[] = [];
  GatewayKind.validateOutputs({
    url: "https://app.example.test",
    host: "other.example.test",
    listener: "public.main",
    routes: [{ pathPrefix: "/", to: "app" }],
    scheme: "http",
  }, issues);

  assertEquals(issues, [
    {
      path: "$.listener",
      message: "must match ^[a-z][a-z0-9-]{0,62}$",
    },
    { path: "$.scheme", message: "must match the scheme in url" },
    { path: "$.host", message: "must match the host in url" },
  ]);
});

function validate(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  GatewayKind.validateSpec(value, issues);
  return issues;
}
