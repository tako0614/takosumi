import { expect, test } from "bun:test";
import { main } from "../../../cli/src/main.ts";

test("FormAvailability CLI is read-only and preserves exact lookup fields", async () => {
  const captured: Request[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    captured.push(request);
    return Response.json({
      forms: [
        {
          identity: {
            formRef: {
              apiVersion: "forms.takoform.com/v1alpha1",
              kind: "ObjectBucket",
              definitionVersion: "1.0.0",
              schemaDigest: `sha256:${"a".repeat(64)}`,
            },
            packageDigest: `sha256:${"b".repeat(64)}`,
          },
          definitionKnown: true,
          installed: true,
          executable: true,
          activated: true,
          availableToPrincipal: true,
          operations: ["create", "read"],
          compatibleAdapterIds: ["opentofu"],
          eligibleTargetPoolClasses: ["object.standard"],
          deprecated: false,
        },
      ],
    });
  }) as typeof fetch;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    expect(
      await main(
        [
          "form-availability",
          "list",
          "--space",
          "space_1",
          "--kind",
          "ObjectBucket",
          "--api-version",
          "forms.takoform.com/v1alpha1",
          "--definition-version",
          "1.0.0",
          "--schema-digest",
          `sha256:${"a".repeat(64)}`,
          "--package-digest",
          `sha256:${"b".repeat(64)}`,
          "--url",
          "https://takosumi.example.test",
          "--token",
          "principal-token",
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      ),
    ).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("ObjectBucket/1.0.0: available");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.headers.get("authorization")).toBe(
      "Bearer principal-token",
    );
    const url = new URL(captured[0]!.url);
    expect(url.pathname).toBe("/v1/form-availability");
    expect(url.searchParams.get("space")).toBe("space_1");
    expect(url.searchParams.get("schemaDigest")).toBe(
      `sha256:${"a".repeat(64)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
