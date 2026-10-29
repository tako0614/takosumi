/**
 * `replaceSecretBlobIfCurrent` parity: every store swaps sealed material only
 * while the row is still exactly the one the caller read, so a re-seal never
 * passes through a moment with no material and never overwrites a concurrent
 * writer.
 */
import { expect, test } from "bun:test";

import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type StoredSecretBlob,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

function sealed(overrides: Partial<StoredSecretBlob> = {}): StoredSecretBlob {
  return {
    id: "secret_runtime_input_cap_replace",
    connectionId: "runtime_input_cap_replace",
    workspaceId: "workspace_replace",
    kind: "runtime-input:cap_replace",
    ciphertext: "Z2VuZXJhdGlvbi1vbmU=",
    encryptedDek: "runtime-input-aes-gcm/v1/runtime-input:cap_replace",
    nonce: "Z2VuZXJhdGlvbi1v",
    aad: '{"profileDigest":"sha256:one"}',
    keyVersion: 1,
    createdAt: "2026-10-29T00:00:00.000Z",
    ...overrides,
  };
}

const NEXT = sealed({
  ciphertext: "Z2VuZXJhdGlvbi10d28=",
  nonce: "Z2VuZXJhdGlvbi10",
  aad: '{"profileDigest":"sha256:two"}',
  rotatedAt: "2026-10-29T01:00:00.000Z",
});

for (const name of ["Memory", "Postgres", "D1"] as const) {
  test(`${name}: sealed material is replaced only while it is still the expected row`, async () => {
    const pg = name === "Postgres" ? await PGliteSqlClient.create() : undefined;
    const d1 = name === "D1" ? new SqliteFakeD1() : undefined;
    const store: OpenTofuControlStore = pg
      ? new SqlOpenTofuControlStore({ client: pg })
      : d1
        ? new CloudflareD1OpenTofuControlStore(d1)
        : new InMemoryOpenTofuControlStore();
    try {
      const first = sealed();
      // Nothing stored: there is nothing to replace, and nothing is created.
      expect(await store.replaceSecretBlobIfCurrent(first, NEXT)).toBe(false);
      expect(await store.getSecretBlob(first.connectionId)).toBeUndefined();

      expect(await store.createSecretBlobIfAbsent(first)).toBe(true);
      const read = await store.getSecretBlob(first.connectionId);
      if (!read) throw new Error("stored row is missing");

      // A caller holding a stale copy loses and the stored row stays intact.
      const stale = { ...read, ciphertext: "c3RhbGUtY29weQ==" };
      expect(await store.replaceSecretBlobIfCurrent(stale, NEXT)).toBe(false);
      expect(await store.getSecretBlob(first.connectionId)).toEqual(first);

      // The exact row is swapped in one step.
      expect(await store.replaceSecretBlobIfCurrent(read, NEXT)).toBe(true);
      expect(await store.getSecretBlob(first.connectionId)).toEqual(NEXT);

      // The superseded row can no longer win: a second writer that read the
      // same original loses instead of overwriting the first writer.
      const competing = { ...NEXT, ciphertext: "Y29tcGV0aW5nLXdyaXRlcg==" };
      expect(await store.replaceSecretBlobIfCurrent(read, competing)).toBe(false);
      expect(await store.getSecretBlob(first.connectionId)).toEqual(NEXT);

      // A replacement may not move the row to another owner reference.
      await expect(
        store.replaceSecretBlobIfCurrent(NEXT, {
          ...NEXT,
          connectionId: "runtime_input_cap_other",
        }),
      ).rejects.toThrow("owner reference");
      await expect(
        store.replaceSecretBlobIfCurrent(NEXT, { ...NEXT, id: "secret_other" }),
      ).rejects.toThrow("owner reference");
      expect(await store.getSecretBlob(first.connectionId)).toEqual(NEXT);
      expect(await store.getSecretBlob("runtime_input_cap_other")).toBeUndefined();
    } finally {
      await pg?.close();
    }
  });
}
