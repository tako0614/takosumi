import { expect, test } from "bun:test";

const WORKFLOW = new URL(
  "../../.github/workflows/standard-form-host-report.yml",
  import.meta.url,
);

test("host report workflow binds one exact request and reviewed runner", async () => {
  const source = await Bun.file(WORKFLOW).text();

  expect(source.match(/^run-name: \$\{\{ inputs\.request_id \}\}$/gmu)).toHaveLength(
    1,
  );
  expect(source).not.toContain("run-name: standard-form-host-report:");
  expect(source).toContain(
    "test \"${GITHUB_WORKFLOW_SHA}\" = \"${GITHUB_SHA}\"",
  );
  expect(source).toContain(
    "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16",
  );
  expect(source).toContain(
    "go run ./cmd/portable-host-conformance self-test",
  );
  expect(source).toContain("console.log(m.portableRunner.path)");
  expect(source.match(/--request-id "\$\{REQUEST_ID\}"/gu)).toHaveLength(5);
  expect(source).not.toContain("latest successful");
});
