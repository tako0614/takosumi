import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasS3ObjectStorageInterface } from "../../../../../dashboard/src/lib/control-api.ts";

const src = (path: string) =>
  readFileSync(
    new URL(`../../../../../dashboard/src/${path}`, import.meta.url),
    "utf8",
  );

const card = src("views/resources/components/S3CustomerAccessKeysCard.tsx");
const detail = src("views/resources/ResourceDetailView.tsx");
const en = src("i18n/en.ts");
const ja = src("i18n/ja.ts");

describe("ObjectBucket S3-compatible customer key UI", () => {
  test("mounts only for the exact canonical ObjectBucket Resource and Interface", () => {
    expect(detail).toContain("S3CustomerAccessKeysCard");
    expect(detail).toContain(
      "tkrn:${current().workspaceId}:ObjectBucket:${current().name}",
    );
    expect(detail).toContain("hasS3ObjectStorageInterface");
    expect(detail).toContain("interfaceError={resolvedInterfaces.error}");
    expect(detail).toContain("interfaceLoading={resolvedInterfaces.loading}");
  });

  test("rejects the legacy Interface and accepts only the current exact Interface", () => {
    const resource = { kind: "ObjectBucket", name: "assets" } as const;
    expect(
      hasS3ObjectStorageInterface([
        { type: "storage.object", version: "v1", resource },
      ]),
    ).toBe(false);
    expect(
      hasS3ObjectStorageInterface([
        { type: "object.storage", version: "1", resource },
      ]),
    ).toBe(true);
  });

  test("uses the dashboard client, explicit grants, and a browser-generated idempotency key", () => {
    expect(card).toContain("listS3CustomerAccessKeys");
    expect(card).toContain(
      "listS3CustomerAccessKeys(props.workspaceId, props.resourceId)",
    );
    expect(card).toContain("createS3CustomerAccessKey");
    expect(card).toContain("revokeS3CustomerAccessKey");
    expect(card).toContain("resourceId: props.resourceId");
    expect(card).toContain("resourceName: props.resourceName");
    expect(card).toContain("idempotencyKey: idempotencyKey()");
    expect(card).toContain('"get"');
    expect(card).toContain('"list"');
    expect(card).toContain('"put"');
    expect(card).toContain('"delete"');
    expect(card).not.toContain("storage.read");
    expect(card).not.toContain("storage.list");
    expect(card).not.toContain("storage.write");
    expect(card).not.toContain("principalId");
  });

  test("keeps the secret in the one-time reveal and distinguishes Cloud API keys", () => {
    expect(card).toContain("secretAccessKey");
    expect(card).toContain("AWS_SECRET_ACCESS_KEY=");
    expect(card).toContain("setCreated(undefined)");
    expect(card).toContain("navigator.clipboard.writeText");
    expect(en).toContain("separate from a Takosumi Cloud API key");
    expect(ja).toContain("Takosumi Cloud API キーとは別のもの");
  });

  test("keeps the Resource visible and names unavailable/forbidden surfaces", () => {
    expect(card).toContain("interfaceUnavailable");
    expect(card).toContain("cause.status === 403");
    expect(card).toContain("[404, 501, 503].includes(cause.status)");
    expect(en).toContain("The Resource is still visible.");
    expect(ja).toContain("Resource は引き続き表示しています");
  });
});
