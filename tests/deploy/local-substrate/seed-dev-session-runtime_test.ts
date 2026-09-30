import { expect, test } from "bun:test";
import {
  seedLocalDevSession,
  type LocalDevSessionPool,
} from "../../../deploy/local-substrate/scripts/seed-dev-session-runtime.ts";

const SESSION_ID = "sess_synthetic_bearer_value";
const SUBJECT = "tsub_synthetic_subject_pii";
const NOW = new Date("2026-09-30T12:00:00.000Z");

function syntheticPool(options: {
  readonly failAtQuery?: number;
  readonly errorMessage?: string;
  readonly endErrorMessage?: string;
} = {}): {
  readonly pool: LocalDevSessionPool;
  readonly queries: { sql: string; values: readonly unknown[] }[];
} {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  return {
    queries,
    pool: {
      query: async (sql, values = []) => {
        queries.push({ sql, values });
        if (queries.length === options.failAtQuery) {
          throw new Error(options.errorMessage ?? "synthetic query failure");
        }
      },
      end: async () => {
        if (options.endErrorMessage) throw new Error(options.endErrorMessage);
      },
    },
  };
}

test("local dev session seed logs a value-free success outcome", async () => {
  const { pool, queries } = syntheticPool();
  const output: string[] = [];

  await seedLocalDevSession({
    createPool: async () => pool,
    sessionId: SESSION_ID,
    subject: SUBJECT,
    sessionHashSalt: "synthetic-session-hash-salt",
    now: NOW,
    log: (message) => output.push(message),
  });

  expect(output).toEqual(["[local-substrate] seeded dev account session"]);
  expect(queries).toHaveLength(3);
  expect(queries[0]?.sql).toContain("INSERT INTO accounts_v1.accounts");
  expect(queries[1]?.sql).toContain(
    "INSERT INTO accounts_v1.account_sessions",
  );
  expect(queries[2]?.sql).toContain(
    "DELETE FROM accounts_v1.account_sessions WHERE session_id = $1",
  );
  const sessionHash = queries[1]?.values[0];
  expect(typeof sessionHash).toBe("string");
  expect(sessionHash).not.toBe(SESSION_ID);
  const logged = output.join("\n");
  expect(logged).not.toContain(SESSION_ID);
  expect(logged).not.toContain(sessionHash as string);
  expect(logged).not.toContain(SUBJECT);
  expect(logged).not.toContain(`${SUBJECT}@local-substrate.test`);

  expect(queries[0]?.values[0]).toBe(SUBJECT);
  expect(queries[1]?.values[1]).toBe(SUBJECT);
  expect(queries[2]?.values[0]).toBe(SESSION_ID);
  expect(queries[1]?.values[2]).toEqual(NOW);
  expect(queries[1]?.values[3]).toEqual(
    new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
  );
});

test("local dev session seed suppresses database error values", async () => {
  const sessionHash = await testSessionHash(
    SESSION_ID,
    "synthetic-session-hash-salt",
  );
  const { pool } = syntheticPool({
    failAtQuery: 2,
    errorMessage: `connection failed ${SESSION_ID} ${sessionHash} ${SUBJECT} synthetic-db-secret`,
  });
  const output: string[] = [];

  let capturedError: unknown;
  try {
    await seedLocalDevSession({
      createPool: async () => pool,
      sessionId: SESSION_ID,
      subject: SUBJECT,
      sessionHashSalt: "synthetic-session-hash-salt",
      log: (message) => output.push(message),
    });
  } catch (error) {
    capturedError = error;
  }

  expect(capturedError).toBeInstanceOf(Error);
  const errorText = String(capturedError);
  expect(errorText).toBe("Error: failed to seed local dev account session");
  expect(errorText).not.toContain(SESSION_ID);
  expect(errorText).not.toContain(sessionHash);
  expect(errorText).not.toContain(SUBJECT);
  expect(errorText).not.toContain("synthetic-db-secret");
  expect(output).toEqual([
    "[local-substrate] failed to seed local dev account session",
  ]);
  const logged = output.join("\n");
  expect(logged).not.toContain(SESSION_ID);
  expect(logged).not.toContain(sessionHash);
  expect(logged).not.toContain(SUBJECT);
  expect(logged).not.toContain("synthetic-db-secret");
});

test("local dev session seed suppresses pool constructor errors", async () => {
  const output: string[] = [];
  let capturedError: unknown;
  try {
    await seedLocalDevSession({
      createPool: async () => {
        throw new Error(`invalid database URL synthetic-db-url ${SESSION_ID}`);
      },
      sessionId: SESSION_ID,
      subject: SUBJECT,
      log: (message) => output.push(message),
    });
  } catch (error) {
    capturedError = error;
  }

  expect(capturedError).toBeInstanceOf(Error);
  const errorText = String(capturedError);
  expect(errorText).toBe("Error: failed to seed local dev account session");
  expect(errorText).not.toContain("synthetic-db-url");
  expect(errorText).not.toContain(SESSION_ID);
  expect(output).toEqual([
    "[local-substrate] failed to seed local dev account session",
  ]);
  expect(output.join("\n")).not.toContain("synthetic-db-url");
});

test("local dev session seed suppresses pool close errors", async () => {
  const sessionHash = await testSessionHash(
    SESSION_ID,
    "synthetic-session-hash-salt",
  );
  const { pool } = syntheticPool({
    endErrorMessage: `pool close failed ${SESSION_ID} ${sessionHash} ${SUBJECT} synthetic-db-secret`,
  });
  const output: string[] = [];
  let capturedError: unknown;
  try {
    await seedLocalDevSession({
      createPool: async () => pool,
      sessionId: SESSION_ID,
      subject: SUBJECT,
      sessionHashSalt: "synthetic-session-hash-salt",
      log: (message) => output.push(message),
    });
  } catch (error) {
    capturedError = error;
  }

  expect(capturedError).toBeInstanceOf(Error);
  const errorText = String(capturedError);
  expect(errorText).toBe(
    "Error: failed to close local dev account session database pool",
  );
  expect(errorText).not.toContain(SESSION_ID);
  expect(errorText).not.toContain(sessionHash);
  expect(errorText).not.toContain(SUBJECT);
  expect(errorText).not.toContain("synthetic-db-secret");
  expect(output).toEqual([
    "[local-substrate] failed to close local dev account session database pool",
  ]);
  expect(output.join("\n")).not.toContain(sessionHash);
  expect(output.join("\n")).not.toContain("synthetic-db-secret");
});

async function testSessionHash(
  sessionId: string,
  salt: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${sessionId}`),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return `sha256:${btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}
