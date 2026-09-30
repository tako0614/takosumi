import { expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { digestBytes } from "../../runner/lib/util.ts";
import { savedPlanStateMetadata, SAVED_PLAN_PREFLIGHT_MAX_BYTES } from "../../runner/lib/saved_plan_state_metadata.ts";
import { handleRunnerRequestWithDependencies } from "../../runner/lib/http_server.ts";
import { assertSavedPlanMatchesState } from "../../core/shared/open-tofu-state-metadata.ts";

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; text: string; declaredSize?: number; descriptor?: boolean }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = encoder.encode(entry.text);
    const compressed = new Uint8Array(deflateRawSync(body));
    const local = new Uint8Array(30 + name.length + compressed.length + (entry.descriptor ? 16 : 0));
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, entry.descriptor ? 8 : 0, true);
    lv.setUint16(8, 8, true);
    if (!entry.descriptor) {
      lv.setUint32(14, crc32(body), true);
      lv.setUint32(18, compressed.length, true);
      lv.setUint32(22, entry.declaredSize ?? body.length, true);
    }
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(compressed, 30 + name.length);
    if (entry.descriptor) {
      const descriptor = new DataView(local.buffer, 30 + name.length + compressed.length, 16);
      descriptor.setUint32(0, 0x08074b50, true);
      descriptor.setUint32(4, crc32(body), true);
      descriptor.setUint32(8, compressed.length, true);
      descriptor.setUint32(12, body.length, true);
    }
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, entry.descriptor ? 8 : 0, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc32(body), true);
    cv.setUint32(20, compressed.length, true);
    cv.setUint32(24, entry.declaredSize ?? body.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local);
    central.push(cd);
    offset += local.length;
  }
  const directoryLength = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directoryLength, true);
  ev.setUint32(16, offset, true);
  const output = new Uint8Array(offset + directoryLength + eocd.length);
  let at = 0;
  for (const part of [...parts, ...central, eocd]) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}

async function inspect(archive: Uint8Array) {
  return savedPlanStateMetadata(archive, await digestBytes(archive));
}

test("saved Plan preflight reads only ZIP tfstate metadata and admits explicit import/moved plan shapes", async () => {
  const plan = zip([
    { name: "tfplan", text: "opaque native plan with import and moved metadata" },
    { name: "tfstate", text: '{"lineage":"lineage-a","serial":7,"resources":[{"secret":"never-log"}]}' },
  ]);
  const metadata = await inspect(plan);
  expect(metadata).toEqual({ lineage: "lineage-a", serial: 7 });
  expect(() => assertSavedPlanMatchesState(metadata, { lineage: "lineage-a", serial: 7 })).not.toThrow();
  expect(() => assertSavedPlanMatchesState(metadata, { lineage: "lineage-a", serial: 8 })).toThrow();
  expect(() => assertSavedPlanMatchesState(metadata, { lineage: "lineage-b", serial: 7 })).toThrow();
  expect(() => assertSavedPlanMatchesState({ lineage: "", serial: 0 }, { lineage: "arbitrary", serial: 0 })).not.toThrow();
});

test("saved Plan preflight accepts Go-style ZIP data descriptors", async () => {
  const plan = zip([{ name: "tfstate", text: '{"lineage":"go-plan","serial":4}', descriptor: true }]);
  expect(await inspect(plan)).toEqual({ lineage: "go-plan", serial: 4 });
});

test("saved Plan preflight refuses missing, duplicate, corrupt, oversized, invalid and wrong-digest metadata", async () => {
  const valid = { name: "tfstate", text: '{"lineage":"a","serial":2}' };
  const cases = [
    zip([{ name: "tfplan", text: "opaque" }]),
    zip([valid, valid]),
    zip([{ ...valid, declaredSize: 32 * 1024 * 1024 + 1 }]),
    zip([{ name: "tfstate", text: '{"lineage":2,"serial":2,"secret":"never-log"}' }]),
  ];
  const corrupt = zip([valid]);
  corrupt[36] = corrupt[36]! ^ 1;
  cases.push(corrupt);
  for (const archive of cases) {
    await expect(inspect(archive)).rejects.toThrow();
  }
  await expect(savedPlanStateMetadata(zip([valid]), `sha256:${"0".repeat(64)}`)).rejects.toThrow();
  await expect(savedPlanStateMetadata(
    new Uint8Array(SAVED_PLAN_PREFLIGHT_MAX_BYTES + 1),
    `sha256:${"0".repeat(64)}`,
  )).rejects.toThrow();
});

test("private runner metadata route refuses bad digest without exposing state values", async () => {
  const archive = zip([{ name: "tfstate", text: '{"lineage":"secret-lineage","serial":1}' }]);
  const accepted = await handleRunnerRequestWithDependencies(
    new Request("http://runner/runs/plan_1/plan-state-metadata", {
      method: "POST",
      headers: { "x-takosumi-plan-digest": await digestBytes(archive) },
      body: archive,
    }),
    { mutationCustodyMode: "cloudflare-do" },
  );
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ lineage: "secret-lineage", serial: 1 });
  const response = await handleRunnerRequestWithDependencies(
    new Request("http://runner/runs/plan_1/plan-state-metadata", {
      method: "POST",
      headers: { "x-takosumi-plan-digest": `sha256:${"0".repeat(64)}` },
      body: archive,
    }),
    { mutationCustodyMode: "cloudflare-do" },
  );
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("secret-lineage");
});
