import assert from "node:assert/strict";
import { test } from "bun:test";

const root = new URL("../../", import.meta.url);

test("deploy action wraps the deploy control API", async () => {
  const source = await Bun.file(
    new URL("actions/deploy/action.yml", root),
  ).text();

  assert.match(source, /name: Takosumi Deploy/);
  // SHA-pinned with a `# pinned: vX.Y.Z` trailer (supply-chain hardening).
  assert.match(source, /oven-sh\/setup-bun@[0-9a-f]{40} # pinned: v2/);
  assert.match(source, /bunx --bun "@takosjp\/takosumi@/);
  assert.match(source, /deploy "\$TAKOSUMI_ACTION_SOURCE"/);
  assert.match(source, /plan "\$TAKOSUMI_ACTION_SOURCE"/);
  assert.match(source, /--space "\$TAKOSUMI_ACTION_SPACE"/);
  assert.match(source, /--remote "\$TAKOSUMI_ACTION_REMOTE_URL"/);
  assert.match(source, /--token "\$TAKOSUMI_DEPLOY_CONTROL_TOKEN"/);
  assert.match(source, /TAKOSUMI_ACTION_PROVIDERS/);
  assert.match(source, /provider_args/);
  assert.doesNotMatch(source, /\/v1\/plan-runs/);
  assert.equal(source.includes(`takosumi-${"git"}`), false);
});

test("OpenTofu sample uses the reusable Deploy Control action", async () => {
  const workflow = await Bun.file(
    new URL(
      "examples/opentofu-basic/.github/workflows/deploy.yml",
      root,
    ),
  ).text();
  const metadata = await Bun.file(
    new URL("examples/opentofu-basic/package.json", root),
  ).json() as { name?: string; description?: string };
  const readme = await Bun.file(
    new URL("examples/opentofu-basic/README.md", root),
  ).text();

  assert.match(workflow, /tako0614\/takosumi\/actions\/deploy@v1/);
  assert.match(workflow, /source: \./);
  assert.match(workflow, /vars\.TAKOSUMI_SPACE_ID/);
  assert.match(workflow, /vars\.TAKOSUMI_PROVIDER_CONNECTIONS/);
  assert.match(workflow, /secrets\.TAKOSUMI_REMOTE_URL/);
  assert.match(workflow, /secrets\.TAKOSUMI_DEPLOY_CONTROL_TOKEN/);
  assert.equal(metadata.name, "opentofu-basic-sample");
  assert.match(metadata.description ?? "", /OpenTofu-native Takosumi source/);
  assert.match(readme, /\/install\?git=/);
  assert.match(readme, /\/api\/v1\/\*/);
  assert.doesNotMatch(readme, /\/v1\/plan-runs/);
  assert.equal(workflow.includes(`takosumi-${"git"}`), false);
});
