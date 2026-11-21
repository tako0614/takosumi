import { expect, test } from "bun:test";
import { buildReAdoptionInputs, initialReAdoptionDrafts } from "../../../../dashboard/src/lib/re-adoption-inputs.ts";
import { reAdoptionContext } from "../../fixtures/re-adoption-context.ts";

test("full replacement preserves eligible optional false empty and null values", () => {
  const context = reAdoptionContext();
  const drafts = initialReAdoptionDrafts(context);
  expect(buildReAdoptionInputs(context, drafts)).toMatchObject({ ok: false, missing: ["release_note"] });
  expect(buildReAdoptionInputs(context, { ...drafts, release_note: { mode: "set", text: "fixture-note" } })).toEqual({
    ok: true, variables: { release_note: "fixture-note", optional_flag: false, empty_value: "", json_value: null },
  });
});

test("only an explicit optional unset removes its previous value", () => {
  const context = reAdoptionContext();
  const drafts = { ...initialReAdoptionDrafts(context), release_note: { mode: "set" as const, text: "fixture-note" } };
  expect(buildReAdoptionInputs(context, { ...drafts, optional_flag: { mode: "unset", text: "" } })).toEqual({
    ok: true, variables: { release_note: "fixture-note", empty_value: "", json_value: null },
  });
  expect(buildReAdoptionInputs(context, { ...drafts, release_note: { mode: "unset", text: "" } })).toMatchObject({ ok: false, missing: ["release_note"] });
});

test("unavailable current values need an explicit replacement or optional unset", () => {
  const context = reAdoptionContext();
  context.variables = [{ ...context.variables[1]!, currentValue: { status: "unavailable" } }];
  const drafts = initialReAdoptionDrafts(context);
  expect(buildReAdoptionInputs(context, drafts)).toMatchObject({ ok: false, invalid: ["optional_flag"] });
  expect(buildReAdoptionInputs(context, { optional_flag: { mode: "keep", text: "" } })).toMatchObject({ ok: false });
  expect(buildReAdoptionInputs(context, { optional_flag: { mode: "unset", text: "" } })).toEqual({ ok: true, variables: {} });
  expect(buildReAdoptionInputs(context, { optional_flag: { mode: "set", text: "true" } })).toEqual({ ok: true, variables: { optional_flag: true } });
});

test("typed values reject malformed nonfinite duplicate and undeclared answers", () => {
  const context = reAdoptionContext();
  context.variables = [{ ...context.variables[0]!, type: "number" }];
  expect(buildReAdoptionInputs(context, { release_note: { mode: "set", text: "12" } })).toEqual({ ok: true, variables: { release_note: 12 } });
  for (const value of ["", "not-a-number", "Infinity"]) {
    expect(buildReAdoptionInputs(context, { release_note: { mode: "set", text: value } }).ok).toBe(false);
  }
  context.variables = [{ ...context.variables[0]!, type: "json" }];
  expect(buildReAdoptionInputs(context, { release_note: { mode: "set", text: '{"count":1e999}' } }).ok).toBe(false);
  expect(buildReAdoptionInputs(context, { release_note: { mode: "set", text: "{}" }, unknown_input: { mode: "set", text: "x" } }).ok).toBe(false);
  context.variables = [context.variables[0]!, context.variables[0]!];
  expect(buildReAdoptionInputs(context, { release_note: { mode: "set", text: "{}" } }).ok).toBe(false);
});

test("blocked and non-user secret or unknown declarations cannot produce a request", () => {
  const context = reAdoptionContext();
  const drafts = { ...initialReAdoptionDrafts(context), release_note: { mode: "set" as const, text: "fixture-note" } };
  for (const blockedReason of ["secret_inputs", "unsupported_inputs", "host_policy_conflict"] as const) {
    expect(buildReAdoptionInputs({ ...context, blockedReason }, drafts)).toMatchObject({ ok: false, blocked: true });
  }
  for (const poison of [{ userEditable: false }, { sensitive: true }, { type: "unknown" }]) {
    const bad = { ...context, variables: [{ ...context.variables[0]!, ...poison }] } as unknown as typeof context;
    expect(buildReAdoptionInputs(bad, { release_note: { mode: "set", text: "fixture-note" } }).ok).toBe(false);
  }
});
