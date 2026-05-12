import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);

Deno.test("deploy action is a direct kernel deploy wrapper", async () => {
  const source = await Deno.readTextFile(
    new URL("actions/deploy/action.yml", root),
  );

  assert.match(source, /name: Takosumi Deploy/);
  assert.match(source, /jsr:@takos\/takosumi-cli@/);
  assert.match(source, /deploy "\$TAKOSUMI_ACTION_MANIFEST"/);
  assert.match(source, /--remote "\$TAKOSUMI_ACTION_REMOTE_URL"/);
  assert.match(source, /--token "\$TAKOSUMI_DEPLOY_TOKEN"/);
  assert.equal(source.includes("takosumi-git"), false);
  assert.equal(source.includes(".takosumi"), false);
});

Deno.test("deploy action docs show the raw unmanaged deploy path", async () => {
  const docs = await Deno.readTextFile(new URL("docs/reference/cli.md", root));

  assert.match(docs, /actions\/deploy@v1/);
  assert.match(docs, /AppInstallation ownership/);
  assert.match(docs, /POST \/v1\/deployments/);
});

Deno.test("direct deploy sample uses the reusable action without takosumi-git", async () => {
  const workflow = await Deno.readTextFile(
    new URL(
      "examples/direct-deploy/.github/workflows/deploy.yml",
      root,
    ),
  );
  const manifest = await Deno.readTextFile(
    new URL("examples/direct-deploy/manifest.yml", root),
  );
  const readme = await Deno.readTextFile(
    new URL("examples/direct-deploy/README.md", root),
  );

  assert.match(workflow, /tako0614\/takosumi\/actions\/deploy@v1/);
  assert.match(workflow, /manifest: manifest\.yml/);
  assert.match(workflow, /secrets\.TAKOSUMI_REMOTE_URL/);
  assert.match(workflow, /secrets\.TAKOSUMI_DEPLOY_TOKEN/);
  assert.match(manifest, /kind: Manifest/);
  assert.match(manifest, /resources:/);
  assert.match(readme, /POST \/v1\/deployments/);
  assert.equal(workflow.includes("takosumi-git"), false);
  assert.equal(workflow.includes(".takosumi"), false);
});
