import { test } from "bun:test";
import assert from "node:assert/strict";
import { providerMatches } from "../../../../core/domains/deploy-control/mod.ts";

// providerMatches backs the RunnerProfile provider allow/deny policy gate. It must
// compare explicit sources only. A bare local name must never widen a policy.

test("exact provider/rule match", () => {
  assert.equal(providerMatches("cloudflare", "cloudflare"), true);
});

test("fully-qualified provider does not match an ambiguous local-name rule", () => {
  assert.equal(
    providerMatches(
      "registry.opentofu.org/cloudflare/cloudflare",
      "cloudflare",
    ),
    false,
  );
});

test("fully-qualified provider matches an explicit namespace/type rule", () => {
  assert.equal(
    providerMatches(
      "registry.opentofu.org/cloudflare/cloudflare",
      "cloudflare/cloudflare",
    ),
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
