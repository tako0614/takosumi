import assert from "node:assert/strict";
import {
  InMemoryCorePublicationResolutionStore,
  InMemoryPublicationConsumerBindingStore,
  InMemoryPublicationProjectionStore,
  InMemoryPublicationStore,
  projectPublication,
  type Publication,
  type PublicationConsumerBinding,
} from "./mod.ts";

Deno.test("publication stores current publications, explicit bindings, and projections", async () => {
  const publications = new InMemoryPublicationStore();
  const bindings = new InMemoryPublicationConsumerBindingStore();
  const resolutions = new InMemoryCorePublicationResolutionStore();
  const projections = new InMemoryPublicationProjectionStore();

  const publication: Publication = {
    id: "pub_docs_1",
    spaceId: "space_a",
    producerGroupId: "docs",
    activationId: "act_docs_1",
    appReleaseId: "release_docs_1",
    name: "site",
    address: "docs/site",
    contract: "web.site.v1",
    type: "web-site",
    visibility: "space",
    outputs: [
      { name: "url", valueType: "url", value: "https://docs.example.test" },
      { name: "token", valueType: "secret-ref", sensitive: true },
    ],
    policy: { withdrawal: "mark-unavailable", rebind: "compatible-only" },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
  };
  const binding: PublicationConsumerBinding = {
    id: "bind_web_docs",
    spaceId: "space_a",
    consumerGroupId: "web",
    publicationAddress: "docs/site",
    contract: "web.site.v1",
    outputs: {
      SITE_URL: {
        outputName: "url",
        env: "SITE_URL",
        valueType: "url",
        explicit: true,
      },
    },
    grantRef: "grant_docs_site",
    rebindPolicy: "compatible-only",
    createdAt: "2026-04-27T00:00:01.000Z",
    updatedAt: "2026-04-27T00:00:01.000Z",
  };

  await publications.put(publication);
  await bindings.put(binding);
  await resolutions.put({
    id: "resolution_web_docs",
    digest: "sha256:resolution",
    spaceId: "space_a",
    consumerGroupId: "web",
    bindingId: "bind_web_docs",
    publicationId: "pub_docs_1",
    publicationAddress: "docs/site",
    producerGroupId: "docs",
    activationId: "act_docs_1",
    appReleaseId: "release_docs_1",
    contract: "web.site.v1",
    outputs: [{
      name: "url",
      valueType: "url",
      value: "https://docs.example.test",
      injectedAs: { env: "SITE_URL" },
    }],
    resolvedAt: "2026-04-27T00:00:02.000Z",
    status: "ready",
    withdrawn: false,
    diagnostics: [],
    rebindCandidate: false,
  });
  const projection = projectPublication({
    id: "projection_web_docs",
    binding,
    publication,
    projectedAt: "2026-04-27T00:00:02.000Z",
  });
  await projections.put(projection);

  assert.equal(
    (await publications.findCurrentByAddress("space_a", "docs/site"))?.id,
    "pub_docs_1",
  );
  assert.deepEqual(
    (await bindings.listByConsumer("space_a", "web")).map((item) => item.id),
    ["bind_web_docs"],
  );
  assert.deepEqual(projection.outputs.map((output) => output.name), ["url"]);
  assert.equal(projection.outputs[0]?.injectedAs?.env, "SITE_URL");
  assert.deepEqual(
    (await resolutions.listByBinding("bind_web_docs")).map((item) => item.id),
    ["resolution_web_docs"],
  );
  assert.deepEqual(
    (await projections.listByPublication("pub_docs_1")).map((item) => item.id),
    ["projection_web_docs"],
  );
});

Deno.test("withdrawn publications are omitted from current lookup by default", async () => {
  const publications = new InMemoryPublicationStore();
  await publications.put({
    id: "pub_old",
    spaceId: "space_a",
    producerGroupId: "docs",
    activationId: "act_old",
    name: "site",
    address: "docs/site",
    contract: "web.site.v1",
    type: "web-site",
    visibility: "space",
    outputs: [],
    policy: { withdrawal: "retain-last-projection", rebind: "never" },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    withdrawnAt: "2026-04-27T00:05:00.000Z",
  });

  assert.equal(
    await publications.findCurrentByAddress("space_a", "docs/site"),
    undefined,
  );
  assert.deepEqual((await publications.list()).map((item) => item.id), []);
  assert.deepEqual(
    (await publications.list({ includeWithdrawn: true })).map((item) =>
      item.id
    ),
    ["pub_old"],
  );
});
