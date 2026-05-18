import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("deploy action wraps the installer API", async () => {
  const source = await Deno.readTextFile(
    new URL("actions/deploy/action.yml", root),
  );

  assert.match(source, /name: Takosumi Deploy/);
  assert.match(source, /jsr:@takos\/takosumi-cli@/);
  assert.match(source, /install "\$TAKOSUMI_ACTION_SOURCE"/);
  assert.match(source, /install dry-run "\$TAKOSUMI_ACTION_SOURCE"/);
  assert.match(source, /--space "\$TAKOSUMI_ACTION_SPACE"/);
  assert.match(source, /--remote "\$TAKOSUMI_ACTION_REMOTE_URL"/);
  assert.match(source, /--token "\$TAKOSUMI_INSTALLER_TOKEN"/);
  assert.equal(source.includes(`takosumi-${"git"}`), false);
  assert.equal(source.includes(".takosumi"), false);
});

Deno.test("direct deploy sample uses the reusable installer action", async () => {
  const workflow = await Deno.readTextFile(
    new URL(
      "examples/direct-deploy/.github/workflows/deploy.yml",
      root,
    ),
  );
  const manifest = await Deno.readTextFile(
    new URL("examples/direct-deploy/.takosumi.yml", root),
  );
  const readme = await Deno.readTextFile(
    new URL("examples/direct-deploy/README.md", root),
  );

  assert.match(workflow, /tako0614\/takosumi\/actions\/deploy@v1/);
  assert.match(workflow, /source: \./);
  assert.match(workflow, /vars\.TAKOSUMI_SPACE_ID/);
  assert.match(workflow, /secrets\.TAKOSUMI_REMOTE_URL/);
  assert.match(workflow, /secrets\.TAKOSUMI_INSTALLER_TOKEN/);
  assert.match(manifest, /kind: App/);
  assert.match(manifest, /components:/);
  assert.match(readme, /\/v1\/installations/);
  assert.equal(workflow.includes(`takosumi-${"git"}`), false);
});
