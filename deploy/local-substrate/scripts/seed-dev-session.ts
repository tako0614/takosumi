#!/usr/bin/env bun

type PgModule = {
  Pool?: new (options: { connectionString: string }) => {
    query: (sql: string, values?: readonly unknown[]) => Promise<unknown>;
    end: () => Promise<void>;
  };
  default?: PgModule;
};

const databaseUrl =
  process.env.TAKOSUMI_ACCOUNTS_DATABASE_URL ?? process.env.DATABASE_URL;
const sessionId = process.env.TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID;
const subject = process.env.TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT;

// No session id means no fixture bearer for this stack. The id is generated per
// bring-up by scripts/up.sh precisely so that a stack started without it (or a
// stack reachable from the LAN) has no long-lived replayable credential to seed.
if (!sessionId) {
  process.exit(0);
}

if (!databaseUrl) {
  throw new Error(
    "TAKOSUMI_ACCOUNTS_DATABASE_URL or DATABASE_URL is required to seed a dev session",
  );
}
if (!sessionId.startsWith("sess_")) {
  throw new Error(
    "TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID must be set and use the sess_ prefix",
  );
}
if (!subject?.startsWith("tsub_")) {
  throw new Error(
    "TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT must be set and use the tsub_ prefix",
  );
}

const pgModule = (await import("pg")) as PgModule;
const Pool = pgModule.Pool ?? pgModule.default?.Pool;
if (!Pool) {
  throw new Error("pg Pool export was not found");
}

const pool = new Pool({ connectionString: databaseUrl });
const now = new Date();
const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
const sessionHash = await hashSessionId(sessionId);

try {
  await pool.query(
    `
      INSERT INTO accounts_v1.accounts
        (subject, email, email_verified, display_name, created_at, updated_at)
      VALUES ($1, $2, true, $3, $4, $4)
      ON CONFLICT (subject) DO UPDATE SET
        email = EXCLUDED.email,
        email_verified = EXCLUDED.email_verified,
        display_name = EXCLUDED.display_name,
        updated_at = EXCLUDED.updated_at
    `,
    [
      subject,
      `${subject}@local-substrate.test`,
      "Local Substrate Fixture",
      now,
    ],
  );
  await pool.query(
    `
      INSERT INTO accounts_v1.account_sessions
        (session_id, subject, created_at, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (session_id) DO UPDATE SET
        subject = EXCLUDED.subject,
        created_at = EXCLUDED.created_at,
        expires_at = EXCLUDED.expires_at
    `,
    [sessionHash, subject, now, expiresAt],
  );
  await pool.query(
    `DELETE FROM accounts_v1.account_sessions WHERE session_id = $1`,
    [sessionId],
  );
  console.log(
    `[local-substrate] seeded dev account session ${sessionId} for ${subject}`,
  );
} finally {
  await pool.end();
}

async function hashSessionId(rawSessionId: string): Promise<string> {
  const salt =
    process.env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT ??
    "takosumi:dev-only-session-hash-salt";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${rawSessionId}`),
  );
  return `sha256:${base64UrlEncodeBytes(new Uint8Array(digest))}`;
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
