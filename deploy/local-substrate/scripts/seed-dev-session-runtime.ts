export interface LocalDevSessionPool {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export interface SeedLocalDevSessionInput {
  readonly createPool: () => Promise<LocalDevSessionPool>;
  readonly sessionId: string;
  readonly subject: string;
  readonly sessionHashSalt?: string;
  readonly now?: Date;
  readonly log?: (message: string) => void;
}

/** Seed the local fixture without logging bearer, subject, or row keys. */
export async function seedLocalDevSession(
  input: SeedLocalDevSessionInput,
): Promise<void> {
  let pool: LocalDevSessionPool | undefined;
  let failureMessage: string | undefined;

  try {
    pool = await input.createPool();
    await seedLocalDevSessionRows(input, pool);
  } catch {
    // Driver and connection errors can include credentials or SQL parameters.
    failureMessage = "failed to seed local dev account session";
  }

  if (pool) {
    try {
      await pool.end();
    } catch {
      // Do not replace a seed failure with driver text from pool shutdown.
      failureMessage ??= "failed to close local dev account session database pool";
    }
  }

  if (failureMessage) {
    input.log?.(`[local-substrate] ${failureMessage}`);
    throw new Error(failureMessage);
  }

  input.log?.("[local-substrate] seeded dev account session");
}

async function seedLocalDevSessionRows(
  input: SeedLocalDevSessionInput,
  pool: LocalDevSessionPool,
): Promise<void> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const sessionHash = await hashSessionId(
    input.sessionId,
    input.sessionHashSalt,
  );

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
      input.subject,
      `${input.subject}@local-substrate.test`,
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
    [sessionHash, input.subject, now, expiresAt],
  );
  await pool.query(
    `DELETE FROM accounts_v1.account_sessions WHERE session_id = $1`,
    [input.sessionId],
  );
}

async function hashSessionId(
  rawSessionId: string,
  configuredSalt: string | undefined,
): Promise<string> {
  const salt = configuredSalt ?? "takosumi:dev-only-session-hash-salt";
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
