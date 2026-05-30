import { assertEquals } from "jsr:@std/assert@^1.0.6";
import type { ShapeValidationIssue } from "./shape.ts";
import * as validators from "./shape-validators.ts";
import {
  optionalEnum,
  optionalPasswordlessAbsoluteUri,
  requireEnum,
  requireHttpUrl,
} from "./shape-validators.ts";

function collect(
  run: (issues: ShapeValidationIssue[]) => void,
): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  run(issues);
  return issues;
}

Deno.test("requireHttpUrl rejects non-http schemes and embedded credentials", () => {
  assertEquals(
    collect((i) => requireHttpUrl("ftp://example.test", "$.url", i)),
    [{ path: "$.url", message: "must be an absolute http(s) URL" }],
  );
  assertEquals(
    collect((i) =>
      requireHttpUrl("https://user:secret@example.test", "$.url", i)
    ),
    [{ path: "$.url", message: "must not contain embedded credentials" }],
  );
  assertEquals(
    collect((i) => requireHttpUrl("https://example.test", "$.url", i)),
    [],
  );
});

Deno.test("optionalPasswordlessAbsoluteUri skips undefined, rejects passwords", () => {
  assertEquals(
    collect((i) => optionalPasswordlessAbsoluteUri(undefined, "$.url", i)),
    [],
  );
  assertEquals(
    collect((i) => optionalPasswordlessAbsoluteUri("not-url", "$.url", i)),
    [{ path: "$.url", message: "must be an absolute URI" }],
  );
  assertEquals(
    collect((i) =>
      optionalPasswordlessAbsoluteUri(
        "queue://producer:secret@example.test/jobs",
        "$.url",
        i,
      )
    ),
    [{ path: "$.url", message: "must not contain an embedded password" }],
  );
});

Deno.test("requireEnum / optionalEnum share one diagnostic format", () => {
  assertEquals(
    collect((i) => requireEnum("xl", "$.size", ["small", "large"], i)),
    [{ path: "$.size", message: "must be one of: small, large" }],
  );
  assertEquals(
    collect((i) => optionalEnum(undefined, "$.size", ["small", "large"], i)),
    [],
  );
  assertEquals(
    collect((i) => optionalEnum("xl", "$.size", ["small", "large"], i)),
    [{ path: "$.size", message: "must be one of: small, large" }],
  );
});

Deno.test("shared validators export exactly the consumed helper set", () => {
  // Guard against dead exports creeping back in: every exported helper has a
  // consumer in either a kind package or another helper in this module. If a
  // helper is added without a consumer, prune it or wire it up.
  const exported = Object.keys(validators).sort();
  assertEquals(exported, [
    "isNonEmptyString",
    "isNonNegativeInteger",
    "isPort",
    "isPositiveInteger",
    "isRecord",
    "isStringRecord",
    "optionalBoolean",
    "optionalEnum",
    "optionalNonEmptyString",
    "optionalNonNegativeInteger",
    "optionalPasswordlessAbsoluteUri",
    "optionalStringRecord",
    "rejectUnknownFields",
    "requireEnum",
    "requireHttpUrl",
    "requireNonEmptyString",
    "requirePort",
    "requirePositiveInteger",
    "requireRoot",
  ]);
});
