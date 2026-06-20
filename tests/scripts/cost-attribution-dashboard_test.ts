import { expect, test } from "bun:test";

const DASHBOARD_PATH = new URL(
  "../../deploy/observability/grafana/takosumi-cost-attribution.json",
  import.meta.url,
).pathname;

test("cost attribution dashboard carries platform-readiness metrics", async () => {
  const dashboard = JSON.parse(await Bun.file(DASHBOARD_PATH).text());
  const serialized = JSON.stringify(dashboard);

  expect(dashboard.uid).toBe("takosumi-cost-attribution");
  expect(dashboard.title).toBe("Takosumi Cost Attribution");
  for (const metric of [
    "takosumi_cloud_spend_cents_total",
    "takosumi_usage_credits_total",
    "takosumi_installation_usage_units_total",
  ]) {
    expect(serialized).toContain(metric);
  }
  for (const variable of ["DS_PROMETHEUS", "space_id", "provider"]) {
    expect(dashboard.templating.list.map((row: any) => row.name)).toContain(
      variable,
    );
  }
});
