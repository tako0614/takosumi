import assert from "node:assert/strict";
import { buildConnectorRegistry } from "../../src/connectors/factory.ts";

Deno.test("buildConnectorRegistry({}) registers the 6 local adapter connectors", () => {
  const reg = buildConnectorRegistry();
  // 6 local adapter connectors: filesystem + minio + docker-compose + systemd-unit
  // + coredns-local + local-docker
  assert.equal(reg.size(), 6);
  assert.ok(reg.get("object-store@v1", "@takos/filesystem-object-store"));
  assert.ok(reg.get("object-store@v1", "@takos/minio-object-store"));
  assert.ok(reg.get("web-service@v1", "@takos/docker-compose-web-service"));
  assert.ok(reg.get("web-service@v1", "@takos/systemd-web-service"));
  assert.ok(reg.get("gateway@v1", "@takos/coredns-gateway"));
  assert.ok(reg.get("postgres@v1", "@takos/docker-postgres"));
});

Deno.test("buildConnectorRegistry with AWS opts adds 4 cloud connectors when route53HostedZoneId set", () => {
  const reg = buildConnectorRegistry({
    aws: {
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "s",
      fargateSubnetIds: ["subnet-1"],
      route53HostedZoneId: "ZONE-1",
    },
  });
  // 6 local adapters + 4 AWS
  assert.equal(reg.size(), 10);
  assert.ok(reg.get("object-store@v1", "@takos/aws-s3"));
  assert.ok(reg.get("web-service@v1", "@takos/aws-fargate"));
  assert.ok(reg.get("postgres@v1", "@takos/aws-rds"));
  assert.ok(reg.get("gateway@v1", "@takos/aws-route53"));
});

Deno.test("buildConnectorRegistry with GCP opts adds GCS / Cloud Run / Cloud SQL", () => {
  const reg = buildConnectorRegistry({
    gcp: {
      project: "p",
      region: "us-central1",
      bearerToken: "tok",
    },
  });
  // 6 local adapters + 3 GCP (no DNS without zoneName)
  assert.equal(reg.size(), 9);
  assert.ok(reg.get("object-store@v1", "@takos/gcp-gcs"));
  assert.ok(reg.get("web-service@v1", "@takos/gcp-cloud-run"));
  assert.ok(reg.get("postgres@v1", "@takos/gcp-cloud-sql"));
});

Deno.test("buildConnectorRegistry with Cloudflare opts adds R2 / containers / workers / dns when zoneId set", () => {
  const reg = buildConnectorRegistry({
    cloudflare: {
      accountId: "acct-1",
      apiToken: "cf-token",
      zoneId: "zone-1",
    },
  });
  assert.equal(reg.size(), 6 + 4);
  assert.ok(reg.get("object-store@v1", "@takos/cloudflare-r2"));
  assert.ok(reg.get("web-service@v1", "@takos/cloudflare-container"));
  assert.ok(reg.get("worker@v1", "@takos/cloudflare-workers"));
  assert.ok(reg.get("gateway@v1", "@takos/cloudflare-dns"));
});

Deno.test("buildConnectorRegistry with Azure opts adds container-apps", () => {
  const reg = buildConnectorRegistry({
    azure: {
      subscriptionId: "sub-1",
      resourceGroup: "rg-1",
      bearerToken: "tok",
    },
  });
  assert.equal(reg.size(), 7);
  assert.ok(reg.get("web-service@v1", "@takos/azure-container-apps"));
});

Deno.test("buildConnectorRegistry with Kubernetes opts adds k3s-deployment", () => {
  const reg = buildConnectorRegistry({
    kubernetes: {
      apiServerUrl: "https://k8s.local",
      bearerToken: "tok",
    },
  });
  assert.equal(reg.size(), 7);
  assert.ok(reg.get("web-service@v1", "@takos/kubernetes-deployment"));
});

Deno.test("buildConnectorRegistry with denoDeploy opts adds deno-deploy worker connector", () => {
  const reg = buildConnectorRegistry({
    denoDeploy: {
      accessToken: "deno-token",
      organizationId: "org-1",
    },
  });
  assert.equal(reg.size(), 7);
  assert.ok(reg.get("worker@v1", "@takos/deno-deploy"));
});
