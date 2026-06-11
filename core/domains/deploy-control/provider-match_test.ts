import { test } from "bun:test";
import assert from "node:assert/strict";
import { providerMatches } from "./mod.ts";

// providerMatches backs the RunnerProfile provider allow/deny policy gate. It must
// be one-directional: a fully-qualified provider address matches a short rule, but
// a specific fully-qualified RULE must NOT admit an ambiguous bare provider name
// (that would silently widen the allowlist / narrow the denylist).

test("exact provider/rule match", () => {
  assert.equal(providerMatches("cloudflare", "cloudflare"), true);
});

test("fully-qualified provider matches a short rule (hierarchical)", () => {
  assert.equal(
    providerMatches("registry.opentofu.org/cloudflare/cloudflare", "cloudflare"),
    true,
  );
});

test("bare provider name must NOT match a fully-qualified rule (the over-permissive bug)", () => {
  assert.equal(
    providerMatches("aws", "registry.opentofu.org/hashicorp/aws"),
    false,
  );
});

test("different fully-qualified addresses do not match", () => {
  assert.equal(
    providerMatches(
      "registry.opentofu.org/evil/cloudflare",
      "registry.opentofu.org/cloudflare/cloudflare",
    ),
    false,
  );
});

test("unrelated provider/rule do not match", () => {
  assert.equal(providerMatches("cloudflare", "aws"), false);
});
