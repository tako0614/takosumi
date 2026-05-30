import { assertEquals } from "jsr:@std/assert@^1.0.6";
import type { ShapeValidationIssue } from "takosumi-contract/reference/shape";
import { WebServiceKind } from "./web-service.ts";

const BASE = { image: "registry.example.test/app:1", port: 8080 } as const;

Deno.test("WebServiceKind accepts the minimal portable spec without container-subset fields", () => {
  assertEquals(validateSpec({ ...BASE }), []);
});

Deno.test("WebServiceKind accepts an optional healthCheck (interval/timeout are seconds)", () => {
  assertEquals(
    validateSpec({
      ...BASE,
      healthCheck: {
        path: "/healthz",
        interval: 10,
        timeout: 2,
        unhealthyThreshold: 3,
        readinessPath: "/readyz",
      },
    }),
    [],
  );
  // healthCheck is fully optional, including all of its sub-fields.
  assertEquals(validateSpec({ ...BASE, healthCheck: {} }), []);
});

Deno.test("WebServiceKind rejects unknown healthCheck fields and bad units", () => {
  assertEquals(
    validateSpec({
      ...BASE,
      healthCheck: { interval: 0, timeout: 1.5, unsupported: true },
    }),
    [
      { path: "$.healthCheck.unsupported", message: "unknown field" },
      { path: "$.healthCheck.interval", message: "must be a positive integer" },
      { path: "$.healthCheck.timeout", message: "must be a positive integer" },
    ],
  );
  assertEquals(
    validateSpec({ ...BASE, healthCheck: { path: "" } }),
    [{ path: "$.healthCheck.path", message: "must be a non-empty string" }],
  );
  assertEquals(
    validateSpec({ ...BASE, healthCheck: "nope" }),
    [{ path: "$.healthCheck", message: "must be an object" }],
  );
});

Deno.test("WebServiceKind accepts optional volumes with logical source and absolute target", () => {
  assertEquals(
    validateSpec({
      ...BASE,
      volumes: [
        { source: "data", target: "/var/lib/data", persistent: true },
        { source: "vol://cache", target: "/cache" },
      ],
    }),
    [],
  );
});

Deno.test("WebServiceKind requires volume source/target and rejects unknown/typed fields", () => {
  assertEquals(
    validateSpec({
      ...BASE,
      volumes: [
        { target: "/data" },
        { source: "data", target: "", persistent: "yes", extra: 1 },
      ],
    }),
    [
      { path: "$.volumes[0].source", message: "must be a non-empty string" },
      { path: "$.volumes[1].extra", message: "unknown field" },
      { path: "$.volumes[1].target", message: "must be a non-empty string" },
      { path: "$.volumes[1].persistent", message: "must be a boolean" },
    ],
  );
  assertEquals(
    validateSpec({ ...BASE, volumes: "nope" }),
    [{ path: "$.volumes", message: "must be an array" }],
  );
});

function validateSpec(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WebServiceKind.validateSpec(value, issues);
  return issues;
}
