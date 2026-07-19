import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  handleRunnerRequest,
  resolveHighestStableSemverTag,
} from "../../runner/entrypoint.ts";

const RUN_ROOT = Bun.env.TAKOSUMI_OPENTOFU_RUN_ROOT ?? "/tmp/takosumi-runs";

test("stable tag resolver chooses the highest release and peels annotated tags", () => {
  const tag = resolveHighestStableSemverTag(`
1111111111111111111111111111111111111111 refs/tags/v1.2.3
2222222222222222222222222222222222222222 refs/tags/v1.2.3^{}
3333333333333333333333333333333333333333 refs/tags/2.0.0-rc.1
4444444444444444444444444444444444444444 refs/tags/1.12.0
`);
  expect(tag).toEqual({
    tag: "1.12.0",
    commit: "4444444444444444444444444444444444444444",
  });

  expect(
    resolveHighestStableSemverTag(
      "1111111111111111111111111111111111111111 refs/tags/v1.2.3\n2222222222222222222222222222222222222222 refs/tags/v1.2.3^{}\n",
    ),
  ).toEqual({
    tag: "v1.2.3",
    commit: "2222222222222222222222222222222222222222",
  });
});

test("stable tag resolver fails when a normalized version is ambiguous", () => {
  expect(() =>
    resolveHighestStableSemverTag(
      "1111111111111111111111111111111111111111 refs/tags/v1.2.3\n2222222222222222222222222222222222222222 refs/tags/1.2.3\n",
    ),
  ).toThrow(/ambiguous.*1\.2\.3.*v1\.2\.3/u);
  expect(() => resolveHighestStableSemverTag("")).toThrow(
    /no stable SemVer tag/u,
  );
  expect(() =>
    resolveHighestStableSemverTag(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/tags/v2.0.0\n1111111111111111111111111111111111111111 refs/tags/v1.2.3\n2222222222222222222222222222222222222222 refs/tags/1.2.3\n",
    ),
  ).toThrow(/ambiguous.*1\.2\.3.*v1\.2\.3/u);
});

test("source_snapshot_file returns text and a digest of the exact bytes", async () => {
  const runId = `source_file_${crypto.randomUUID().replaceAll("-", "")}`;
  const root = join(RUN_ROOT, runId);
  const bytes = new TextEncoder().encode('{"title":"選択"}\n');
  try {
    await mkdir(join(root, "source", "install"), { recursive: true });
    await writeFile(join(root, "source", "install", "options.json"), bytes);
    const response = await handleRunnerRequest(
      new Request(`https://runner/runs/${runId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "source_snapshot_file",
          request: {
            action: "source_snapshot_file",
            path: "install/options.json",
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const expected = `sha256:${[...digest]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
    expect(body).toMatchObject({
      path: "install/options.json",
      text: '{"title":"選択"}\n',
      digest: expected,
      sizeBytes: bytes.byteLength,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source_snapshot_file rejects traversal and non-JSON is enforced at API layer", async () => {
  const runId = `source_file_${crypto.randomUUID().replaceAll("-", "")}`;
  const response = await handleRunnerRequest(
    new Request(`https://runner/runs/${runId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "source_snapshot_file",
        request: { action: "source_snapshot_file", path: "../secret.json" },
      }),
    }),
  );
  expect(response.status).toBe(500);
  expect(await response.text()).toContain("not a safe relative path");
});
