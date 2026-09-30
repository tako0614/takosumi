#!/usr/bin/env bun

import { seedLocalDevSession } from "./seed-dev-session-runtime.ts";

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

await seedLocalDevSession({
  createPool: async () => new Pool({ connectionString: databaseUrl }),
  sessionId,
  subject,
  sessionHashSalt: process.env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT,
  log: (message) => console.log(message),
});
