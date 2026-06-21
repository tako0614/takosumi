import { expect, test } from "bun:test";

import { CloudflareD1MetricObservabilitySink } from "../../../worker/src/d1_observability.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

test("Cloudflare D1 metric sink persists samples across sink instances", async () => {
  const db = new SqliteFakeD1();
  const observedAt = new Date().toISOString();
  const recorder = new CloudflareD1MetricObservabilitySink({ db });
  await recorder.recordMetric({
    id: "metric_1",
    name: "takosumi_oidc_request_count",
    kind: "counter",
    value: 1,
    tags: {
      environment: "test",
      route: "/oauth/authorize",
      runtime_cell_id: "cell_test",
      status: "200",
    },
    observedAt,
  });

  const scraper = new CloudflareD1MetricObservabilitySink({ db });
  const metrics = await scraper.listMetrics({
    name: "takosumi_oidc_request_count",
  });

  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({
    id: "metric_1",
    name: "takosumi_oidc_request_count",
    kind: "counter",
    value: 1,
    tags: {
      environment: "test",
      route: "/oauth/authorize",
      runtime_cell_id: "cell_test",
      status: "200",
    },
    observedAt,
  });
});
