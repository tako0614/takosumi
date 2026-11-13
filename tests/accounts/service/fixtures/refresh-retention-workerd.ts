import { D1AccountsStore, type D1Database, type D1Value } from "../../../../accounts/service/src/d1-store.ts";
import { advanceD1RefreshRetentionCheckpoint, deleteD1RefreshRetentionCandidate, readD1RefreshRetentionCheckpoint } from "../../../../accounts/service/src/refresh-chain-retention-d1.ts";
import { runRefreshChainRetention } from "../../../../accounts/service/src/refresh-chain-retention.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";

export default {
  async fetch(_request: Request, env: { ACCOUNTS_TEST_DB: D1Database; RETENTION_INDEX_SQL: string }): Promise<Response> {
    // Disposable local Miniflare fixture only. All state and I/O belong to this
    // request and its test binding; no operator DB/identity/custody is supplied.
    const store = new D1AccountsStore(env.ACCOUNTS_TEST_DB);
    await store.initialize();
    const statements = JSON.parse(env.RETENTION_INDEX_SQL) as Array<{ sql: string; params: D1Value[] }>;
    for (const statement of statements) await env.ACCOUNTS_TEST_DB.prepare(statement.sql).bind(...statement.params).run();
    const issuedAt = Date.now();
    const day = 24 * 60 * 60 * 1_000;
    const record = { clientId: "native-fixture-client", subject: "native-fixture-subject", scope: "openid offline_access", expiresAt: issuedAt + 60 * day };
    await store.saveRefreshToken("native-parent", record);
    await store.addRefreshChainLink("native-parent", "native-child");
    await store.saveAccessToken("native-access", record);
    await store.linkAccessTokenToRefreshChain("native-parent", "native-access");
    await store.markAuthorizationCodeConsumed("native-code");
    await store.linkAccessTokenToAuthCode("native-code", "native-access", "native-parent");
    await store.addRefreshChainLink("residue-root", "residue-child");
    await store.revokeRefreshChain("residue-root");
    await store.saveRefreshToken("residue-child", record);
    await store.addRefreshChainLink("expired-parent", "expired-child");
    await store.addRefreshChainLink("unknown-root", "unknown-child");
    await env.ACCOUNTS_TEST_DB.prepare(`UPDATE takosumi_accounts_documents SET document = json_set(document,
      '$.rootHash', null, '$.createdAt', 'unknown') WHERE bucket = 'refresh_chain_links' AND key = ?`)
      .bind(await sha256Text("unknown-root")).run();

    const retained = await runRefreshChainRetention(store, { now: issuedAt + 31 * day,
      refreshTokenTtlMs: day, authorizationCodeTtlMs: 1, maxRows: 20, pageSize: 3 });
    const liveLinkRetained = await store.getRefreshChainChild("native-parent") !== undefined;
    const residueRootRetained = await store.isRefreshRootRevoked("residue-root");
    const markerRetained = await store.isAuthorizationCodeConsumed("native-code");
    const expiredLinkCollected = await store.getRefreshChainChild("expired-parent") === undefined;
    const unknownLinkRetained = await store.getRefreshChainChild("unknown-root") !== undefined;
    await store.revokeTokensIssuedFromCode("native-code");
    const accessRevoked = await store.findAccessToken("native-access") === undefined;
    const refreshRevoked = await store.findRefreshToken("native-parent") === undefined;

    await store.addRefreshChainLink("rollback-parent", "rollback-child");
    const rollbackKey = await sha256Text("rollback-parent");
    const rollbackRow = await env.ACCOUNTS_TEST_DB.prepare(`SELECT json_extract(document, '$.createdAt') AS at
      FROM takosumi_accounts_documents WHERE bucket = 'refresh_chain_links' AND key = ?`).bind(rollbackKey).first<{ at: number }>();
    const indexCount = async () => (await env.ACCOUNTS_TEST_DB.prepare(`SELECT COUNT(*) AS count
      FROM takosumi_accounts_indexes WHERE bucket = 'refresh_chain_links' AND document_key = ?`).bind(rollbackKey).first<{ count: number }>())!.count;
    const indexesBefore = await indexCount();
    await env.ACCOUNTS_TEST_DB.prepare(`CREATE TRIGGER isolated_retention_rollback BEFORE DELETE ON takosumi_accounts_documents
      WHEN OLD.bucket = 'refresh_chain_links' BEGIN SELECT RAISE(ABORT, 'isolated retention rollback'); END`).run();
    let rollbackRefused = false;
    try {
      await deleteD1RefreshRetentionCandidate(env.ACCOUNTS_TEST_DB, { phase: "chain_links", bucket: "refresh_chain_links",
        key: rollbackKey, timestampField: "createdAt", at: rollbackRow!.at, now: issuedAt + 31 * day });
    } catch (error) { rollbackRefused = error instanceof Error && error.message.includes("isolated retention rollback"); }
    await env.ACCOUNTS_TEST_DB.prepare("DROP TRIGGER isolated_retention_rollback").run();
    const atomicRollback = rollbackRefused && indexesBefore > 0 && await indexCount() === indexesBefore &&
      await store.getRefreshChainChild("rollback-parent") !== undefined;

    const initial = await readD1RefreshRetentionCheckpoint(env.ACCOUNTS_TEST_DB);
    const cursor = { phase: "chain_links" as const, after: '[1,"native-fixture-cursor"]' };
    const checkpointAdvanced = await advanceD1RefreshRetentionCheckpoint(env.ACCOUNTS_TEST_DB, initial, cursor);
    const staleResetRefused = !await advanceD1RefreshRetentionCheckpoint(env.ACCOUNTS_TEST_DB, initial, undefined);
    const final = await readD1RefreshRetentionCheckpoint(env.ACCOUNTS_TEST_DB);
    return Response.json({ liveLinkRetained, residueRootRetained, markerRetained,
      expiredLinkCollected, unknownLinkRetained, accessRevoked, refreshRevoked,
      checkpointAdvanced, staleResetRefused, atomicRollback, checkpoint: final,
      counts: { chainLinks: retained.chainLinks, revokedRoots: retained.revokedRoots,
        consumedCodes: retained.consumedCodes, authCodeTokenLinks: retained.authCodeTokenLinks },
      scanned: retained.scanned });
  },
};
