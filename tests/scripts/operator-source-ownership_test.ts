import { expect, test } from "bun:test";
import { runOperatorSourceOwnership } from "../../scripts/operator-source-ownership.ts";

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
