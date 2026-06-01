import assert from "node:assert/strict";
import { test } from "bun:test";

const root = new URL("../", import.meta.url);

test("deploy action wraps the installer API", async () => {
  const source = await Bun.file(
    new URL("actions/deploy/action.yml", root),
  ).text();

  assert.match(source, /name: Takosumi Deploy/);
  assert.match(source, /oven-sh\/setup-bun@v2/);
  assert.match(source, /bunx --bun "@takosjp\/takosumi@/);
  assert.match(source, /install "\$TAKOSUMI_ACTION_SOURCE"/);
  assert.match(source, /install dry-run "\$TAKOSUMI_ACTION_SOURCE"/);
  assert.match(source, /--space "\$TAKOSUMI_ACTION_SPACE"/);
  assert.match(source, /--remote "\$TAKOSUMI_ACTION_REMOTE_URL"/);
  assert.match(source, /--token "\$TAKOSUMI_INSTALLER_TOKEN"/);
  assert.equal(source.includes(`takosumi-${"git"}`), false);
  assert.equal(source.includes(".takosumi"), false);
});

test("direct deploy sample uses the reusable installer action", async () => {
  const workflow = await Bun.file(
    new URL(
      "examples/direct-deploy/.github/workflows/deploy.yml",
      root,
    ),
  ).text();
  const metadata = await Bun.file(
    new URL("examples/direct-deploy/package.json", root),
  ).json() as { name?: string; description?: string };
  const readme = await Bun.file(
    new URL("examples/direct-deploy/README.md", root),
  ).text();

  assert.match(workflow, /tako0614\/takosumi\/actions\/deploy@v1/);
  assert.match(workflow, /source: \./);
  assert.match(workflow, /vars\.TAKOSUMI_SPACE_ID/);
  assert.match(workflow, /secrets\.TAKOSUMI_REMOTE_URL/);
  assert.match(workflow, /secrets\.TAKOSUMI_INSTALLER_TOKEN/);
  assert.equal(metadata.name, "direct-deploy-sample");
  assert.match(metadata.description ?? "", /Manifestless Takosumi source/);
  assert.match(readme, /\/v1\/installations/);
  assert.equal(workflow.includes(`takosumi-${"git"}`), false);
});
