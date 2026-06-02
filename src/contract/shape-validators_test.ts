import { expect, test } from "bun:test";

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

test("requireHttpUrl rejects non-http schemes and embedded credentials", () => {
  expect(collect((i) => requireHttpUrl("ftp://example.test", "$.url", i))).toEqual([{ path: "$.url", message: "must be an absolute http(s) URL" }]);
  expect(collect((i) =>
      requireHttpUrl("https://user:secret@example.test", "$.url", i)
    )).toEqual([{ path: "$.url", message: "must not contain embedded credentials" }]);
  expect(collect((i) => requireHttpUrl("https://example.test", "$.url", i))).toEqual([]);
});

test("optionalPasswordlessAbsoluteUri skips undefined, rejects passwords", () => {
  expect(collect((i) => optionalPasswordlessAbsoluteUri(undefined, "$.url", i))).toEqual([]);
  expect(collect((i) => optionalPasswordlessAbsoluteUri("not-url", "$.url", i))).toEqual([{ path: "$.url", message: "must be an absolute URI" }]);
  expect(collect((i) =>
      optionalPasswordlessAbsoluteUri(
        "queue://producer:secret@example.test/jobs",
        "$.url",
        i,
      )
    )).toEqual([{ path: "$.url", message: "must not contain an embedded password" }]);
});

test("requireEnum / optionalEnum share one diagnostic format", () => {
  expect(collect((i) => requireEnum("xl", "$.size", ["small", "large"], i))).toEqual([{ path: "$.size", message: "must be one of: small, large" }]);
  expect(collect((i) => optionalEnum(undefined, "$.size", ["small", "large"], i))).toEqual([]);
  expect(collect((i) => optionalEnum("xl", "$.size", ["small", "large"], i))).toEqual([{ path: "$.size", message: "must be one of: small, large" }]);
});

test("shared validators export exactly the consumed helper set", () => {
  // Guard against dead exports creeping back in: every exported helper has a
  // consumer in either a backend implementation or another helper in this module. If a
  // helper is added without a consumer, prune it or wire it up.
  const exported = Object.keys(validators).sort();
  expect(exported).toEqual([
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
