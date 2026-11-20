import { expect, test } from "bun:test";
import { runOperatorSourceOwnership } from "../../scripts/operator-source-ownership.ts";

test("operator inventory uses ordered GET pages and preserves each Source's review receipt", async () => {
  const calls: Array<{ after: string | null; method?: string }> = [];
  const reports = ["src_A", "src_a"].map((sourceId, index) => ({
    kind: "takosumi.source-ownership-migration.dry-run@v1",
    preparedAt: `2026-10-28T00:00:0${index}.000Z`,
    reportDigest: `sha256:${String(index).repeat(64)}`,
    results: [{ inventory: { sourceId }, status: "dry_run" }],
  }));
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const params = new URL(String(input)).searchParams;
    expect(params.get("inventoryPage")).toBe("1");
    calls.push({ after: params.get("afterSourceId"), method: init?.method });
    const index = calls.length - 1;
    return Response.json({
      kind: "takosumi.source-ownership-migration.inventory-page@v1",
      report: reports[index],
      nextAfterSourceId: index === 0 ? "src_A" : null,
    });
  };
  const result = await runOperatorSourceOwnership({
    baseUrl: "https://operator.test", apply: false, inventory: true,
  }, "test-token", request as typeof fetch);
  expect(calls).toEqual([{ after: null, method: "GET" }, { after: "src_A", method: "GET" }]);
  expect(result).toEqual({ status: 200, body: {
    kind: "takosumi.source-ownership-migration.inventory@v1", reports,
  } });
});

test("operator inventory refuses a page that repeats the previous Source", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return Response.json({
      kind: "takosumi.source-ownership-migration.inventory-page@v1",
      report: {
        kind: "takosumi.source-ownership-migration.dry-run@v1",
        preparedAt: "2026-10-28T00:00:00.000Z",
        reportDigest: `sha256:${"0".repeat(64)}`,
        results: [{ inventory: { sourceId: "src_A" }, status: "dry_run" }],
      },
      nextAfterSourceId: "src_A",
    });
  };
  await expect(runOperatorSourceOwnership({
    baseUrl: "https://operator.test", apply: false, inventory: true,
  }, "test-token", request as typeof fetch)).rejects.toThrow("invalid_operator_inventory_page");
  expect(calls).toBe(2);
});

test("operator CLI resumes signed archive copy batches before reporting commit", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (requests.length === 1) {
      return Response.json({ kind: "takosumi.source-ownership-migration.copy-pending@v1",
        nextCopyCursor: 16, copiesTotal: 17, copyReceipt: "a".repeat(64) }, { status: 202 });
    }
    return Response.json({ kind: "takosumi.source-ownership-migration.apply@v1",
      results: [{ status: "committed" }] });
  };
  const result = await runOperatorSourceOwnership({
    baseUrl: "https://operator.test", sourceId: "src_example", apply: true,
    preparedAt: "2026-10-28T00:00:00.000Z", reportDigest: `sha256:${"b".repeat(64)}`,
  }, "test-token", request as typeof fetch);
  expect(result.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.body.copyCursor).toBeUndefined();
  expect(requests[1]?.body.copyCursor).toBe(16);
  expect(requests[1]?.body.copyReceipt).toBe("a".repeat(64));
  expect(requests[0]?.url).toBe("https://operator.test/internal/platform/source-ownership-migration");
});
