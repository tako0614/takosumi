import { expect, test } from "bun:test";

import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
  D1Value,
} from "../../../accounts/service/src/d1-store.ts";
import {
  d1AccountsTableNames,
} from "../../../accounts/service/src/d1-store.ts";
import { hashSessionIdWithSalt } from "../../../accounts/service/src/session-hash-salt.ts";
import { deployControlD1TableNames } from "../../../core/adapters/storage/drizzle/schema/logical.ts";
import { defaultProjectId } from "../../../core/domains/projects/mod.ts";
import {
  createCloudflareD1WorkspaceBootstrapReader,
  readWorkspaceBootstrapRequest,
} from "../../../deploy/platform/workspace-bootstrap-reader.ts";

const SESSION_ID = "sess_workspace_bootstrap";
const SESSION_SALT = "workspace-bootstrap-test-session-salt";
const SUBJECT = "tsub_workspace_bootstrap" as const;
const WORKSPACE_ID = "ws_workspace_bootstrap";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-02T00:00:00.000Z";

test("workspace bootstrap request adapter follows canonical credential precedence", async () => {
  const seen: string[] = [];
  const reader = {
    async read(input: {
      readonly sessionId: string;
      readonly workspaceId: string;
      readonly now: number;
    }) {
      seen.push(input.sessionId);
      return { status: "not_owner" as const };
    },
  };

  const result = await readWorkspaceBootstrapRequest(reader, {
    request: new Request("https://platform.example.test/bootstrap", {
      headers: {
        authorization: "Bearer sess_from_bearer",
        "x-takosumi-account-session": "sess_from_header",
        cookie: "takosumi_session=sess_from_cookie",
      },
    }),
    workspaceId: WORKSPACE_ID,
    now: 2_000,
  });

  expect(result).toEqual({ status: "not_owner" });
  expect(seen).toEqual(["sess_from_bearer"]);

  const headerResult = await readWorkspaceBootstrapRequest(reader, {
    request: new Request("https://platform.example.test/bootstrap", {
      headers: {
        "x-takosumi-account-session": "sess_from_header",
        cookie: "takosumi_session=sess_from_cookie",
      },
    }),
    workspaceId: WORKSPACE_ID,
    now: 2_000,
  });
  expect(headerResult).toEqual({ status: "not_owner" });
  expect(seen).toEqual(["sess_from_bearer", "sess_from_header"]);

  const cookieResult = await readWorkspaceBootstrapRequest(reader, {
    request: new Request("https://platform.example.test/bootstrap", {
      headers: { cookie: "takosumi_session=sess_from_cookie" },
    }),
    workspaceId: WORKSPACE_ID,
    now: 2_000,
  });
  expect(cookieResult).toEqual({ status: "not_owner" });
  expect(seen).toEqual([
    "sess_from_bearer",
    "sess_from_header",
    "sess_from_cookie",
  ]);
});

test("workspace bootstrap request adapter rejects missing and non-session credentials", async () => {
  let reads = 0;
  const reader = {
    async read() {
      reads += 1;
      return { status: "not_owner" as const };
    },
  };

  for (const request of [
    new Request("https://platform.example.test/bootstrap"),
    new Request("https://platform.example.test/bootstrap", {
      headers: { authorization: "Bearer takpat_not_a_session" },
    }),
    new Request("https://platform.example.test/bootstrap", {
      headers: { "x-takosumi-account-session": "oauth_access_token" },
    }),
  ]) {
    await expect(
      readWorkspaceBootstrapRequest(reader, {
        request,
        workspaceId: WORKSPACE_ID,
        now: 2_000,
      }),
    ).resolves.toEqual({ status: "invalid_session" });
  }
  expect(reads).toBe(0);
});

test("workspace bootstrap request adapter keeps an invalid preferred credential from falling back", async () => {
  let reads = 0;
  const reader = {
    async read() {
      reads += 1;
      return { status: "not_owner" as const };
    },
  };

  await expect(
    readWorkspaceBootstrapRequest(reader, {
      request: new Request("https://platform.example.test/bootstrap", {
        headers: {
          authorization: "Bearer not-a-session",
          "x-takosumi-account-session": "sess_valid_header",
          cookie: "takosumi_session=sess_valid_cookie",
        },
      }),
      workspaceId: WORKSPACE_ID,
      now: 2_000,
    }),
  ).resolves.toEqual({ status: "invalid_session" });
  expect(reads).toBe(0);
});

test("workspace bootstrap request adapter maps reader failures to unavailable", async () => {
  const reader = {
    async read() {
      throw new Error("unexpected reader failure");
    },
  };

  await expect(
    readWorkspaceBootstrapRequest(reader, {
      request: new Request("https://platform.example.test/bootstrap", {
        headers: { cookie: "takosumi_session=sess_reader_failure" },
      }),
      workspaceId: WORKSPACE_ID,
      now: 2_000,
    }),
  ).resolves.toEqual({ status: "unavailable" });
});

test("workspace bootstrap returns exact authenticated-owner facts in three bounded SELECTs", async () => {
  const evidence = await validEvidence();
  const accountsDb = new CountingD1([evidence.accounts]);
  const controlDb = new CountingD1([
    evidence.membership,
    evidence.control,
  ]);
  const reader = createCloudflareD1WorkspaceBootstrapReader({
    accountsDb,
    controlDb,
    sessionHashSalt: SESSION_SALT,
  });

  const result = await reader.read({
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    now: 2_000,
  });

  expect(result).toEqual({
    status: "authenticated_owner",
    subject: SUBJECT,
    workspace: workspaceRecord(),
    membership: membershipRecord(),
    defaultProject: projectRecord(),
  });
  expect(accountsDb.prepared).toHaveLength(1);
  expect(controlDb.prepared).toHaveLength(2);
  expect(accountsDb.prepared[0]).toContain(d1AccountsTableNames.documents);
  expect(controlDb.prepared[0]).toContain(
    deployControlD1TableNames.workspaceMembers,
  );
  expect(controlDb.prepared[1]).toContain(deployControlD1TableNames.workspaces);
  expect(controlDb.prepared[1]).toContain(deployControlD1TableNames.projects);
  expect(
    [...accountsDb.prepared, ...controlDb.prepared].every((sql) =>
      sql.toLowerCase().includes("limit 2"),
    ),
  ).toBe(true);
  expect(accountsDb.bound[0]).toHaveLength(1);
  expect(accountsDb.bound[0]?.[0]).not.toBe(SESSION_ID);
  expect(String(accountsDb.bound[0]?.[0])).toStartWith("sha256:");
  expect(controlDb.bound).toEqual([
    [WORKSPACE_ID, SUBJECT],
    [
      WORKSPACE_ID,
      defaultProjectId(WORKSPACE_ID),
      WORKSPACE_ID,
    ],
  ]);
  expect(accountsDb.allCalls + controlDb.allCalls).toBe(3);
  assertNoWrites(accountsDb);
  assertNoWrites(controlDb);
});

test("expired and orphaned sessions fail without cleanup or Control reads", async () => {
  const evidence = await validEvidence();
  const expiredSession = JSON.parse(
    evidence.accounts[0]!.session_json as string,
  ) as Record<string, unknown>;
  expiredSession.expiresAt = 2_000;

  for (const accountsRows of [
    [{ ...evidence.accounts[0], session_json: JSON.stringify(expiredSession) }],
    [{ ...evidence.accounts[0], account_key: null, account_json: null }],
    [],
  ]) {
    const accountsDb = new CountingD1([accountsRows]);
    const controlDb = new CountingD1([]);
    const result = await createCloudflareD1WorkspaceBootstrapReader({
      accountsDb,
      controlDb,
      sessionHashSalt: SESSION_SALT,
    }).read({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, now: 2_000 });

    expect(result).toEqual({ status: "invalid_session" });
    expect(accountsDb.allCalls).toBe(1);
    expect(controlDb.prepared).toEqual([]);
    assertNoWrites(accountsDb);
    assertNoWrites(controlDb);
  }
});

test("workspace bootstrap maps D1 exceptions and failed results to unavailable", async () => {
  const evidence = await validEvidence();

  const accountsFailure = new CountingD1([evidence.accounts]);
  accountsFailure.failure = new Error("accounts D1 unavailable");
  await expect(
    createCloudflareD1WorkspaceBootstrapReader({
      accountsDb: accountsFailure,
      controlDb: new CountingD1([]),
      sessionHashSalt: SESSION_SALT,
    }).read({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, now: 2_000 }),
  ).resolves.toEqual({ status: "unavailable" });

  const accountsFailedResult = new CountingD1([evidence.accounts]);
  accountsFailedResult.result = { success: false, results: [] };
  await expect(
    createCloudflareD1WorkspaceBootstrapReader({
      accountsDb: accountsFailedResult,
      controlDb: new CountingD1([]),
      sessionHashSalt: SESSION_SALT,
    }).read({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, now: 2_000 }),
  ).resolves.toEqual({ status: "unavailable" });

  const controlFailure = new CountingD1([
    evidence.membership,
    evidence.control,
  ]);
  controlFailure.failure = new Error("control D1 unavailable");
  controlFailure.failureOnCall = 2;
  await expect(
    createCloudflareD1WorkspaceBootstrapReader({
      accountsDb: new CountingD1([evidence.accounts]),
      controlDb: controlFailure,
      sessionHashSalt: SESSION_SALT,
    }).read({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, now: 2_000 }),
  ).resolves.toEqual({ status: "unavailable" });

  const controlFailedResult = new CountingD1([
    evidence.membership,
    evidence.control,
  ]);
  controlFailedResult.result = { success: false, results: [] };
  controlFailedResult.resultOnCall = 2;
  await expect(
    createCloudflareD1WorkspaceBootstrapReader({
      accountsDb: new CountingD1([evidence.accounts]),
      controlDb: controlFailedResult,
      sessionHashSalt: SESSION_SALT,
    }).read({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, now: 2_000 }),
  ).resolves.toEqual({ status: "unavailable" });

  const membershipFailure = new CountingD1([evidence.membership]);
  membershipFailure.failure = new Error(
    "Workspace membership evidence is malformed",
  );
  const membershipReader = createCloudflareD1WorkspaceBootstrapReader({
    accountsDb: new CountingD1([evidence.accounts]),
    controlDb: membershipFailure,
    sessionHashSalt: SESSION_SALT,
  });
  await expect(
    readWorkspaceBootstrapRequest(membershipReader, {
      request: new Request("https://platform.example.test/bootstrap", {
        headers: { cookie: `takosumi_session=${SESSION_ID}` },
      }),
      workspaceId: WORKSPACE_ID,
      now: 2_000,
    }),
  ).resolves.toEqual({ status: "unavailable" });

  const membershipFailedResult = new CountingD1([evidence.membership]);
  membershipFailedResult.result = { success: false, results: [] };
  await expect(
    createCloudflareD1WorkspaceBootstrapReader({
      accountsDb: new CountingD1([evidence.accounts]),
      controlDb: membershipFailedResult,
      sessionHashSalt: SESSION_SALT,
    }).read({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, now: 2_000 }),
  ).resolves.toEqual({ status: "unavailable" });
});

test("workspace bootstrap maps missing configuration to unavailable", async () => {
  const reader = createCloudflareD1WorkspaceBootstrapReader({
    accountsDb: new CountingD1([]),
    controlDb: new CountingD1([]),
    sessionHashSalt: "",
  });
  await expect(
    reader.read({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, now: 2_000 }),
  ).resolves.toEqual({ status: "unavailable" });
});

test("workspace bootstrap distinguishes non-owner from malformed or duplicate evidence", async () => {
  const evidence = await validEvidence();
  const memberOnly = membershipRow({
    roles: ["member"],
  });
  const nonOwner = await readWithEvidence({
    accounts: evidence.accounts,
    control: [[memberOnly]],
  });
  expect(nonOwner.result).toEqual({ status: "not_owner" });
  expect(nonOwner.controlDb.prepared).toHaveLength(1);

  for (const accounts of [
    [evidence.accounts[0]!, evidence.accounts[0]!],
    [{ ...evidence.accounts[0], session_json: "{" }],
    [{ ...evidence.accounts[0], account_key: "tsub_wrong" }],
    [undefined],
    [null],
  ]) {
    const read = await readWithEvidence({ accounts, control: [] });
    expect(read.result).toEqual({ status: "incomplete" });
    expect(read.controlDb.prepared).toEqual([]);
    assertNoWrites(read.accountsDb);
  }

  const duplicateMembership = await readWithEvidence({
    accounts: evidence.accounts,
    control: [[evidence.membership[0]!, evidence.membership[0]!]],
  });
  expect(duplicateMembership.result).toEqual({ status: "incomplete" });
  expect(duplicateMembership.controlDb.prepared).toHaveLength(1);

  for (const aggregateRows of [
    [evidence.control[0]!, evidence.control[0]!],
    [{ ...evidence.control[0], project_id: "prj_wrong" }],
    [{ ...evidence.control[0], project_record_json: "[]" }],
    [undefined],
    [null],
    [
      {
        ...evidence.control[0],
        workspace_record_json: JSON.stringify({
          ...workspaceRecord(),
          policy: "malformed",
        }),
      },
    ],
  ]) {
    const read = await readWithEvidence({
      accounts: evidence.accounts,
      control: [evidence.membership, aggregateRows],
    });
    expect(read.result).toEqual({ status: "incomplete" });
    expect(read.accountsDb.allCalls + read.controlDb.allCalls).toBe(3);
    assertNoWrites(read.accountsDb);
    assertNoWrites(read.controlDb);
  }
});

async function readWithEvidence(input: {
  readonly accounts: readonly unknown[];
  readonly control: readonly (readonly unknown[])[];
}) {
  const accountsDb = new CountingD1([input.accounts]);
  const controlDb = new CountingD1(input.control);
  const result = await createCloudflareD1WorkspaceBootstrapReader({
    accountsDb,
    controlDb,
    sessionHashSalt: SESSION_SALT,
  }).read({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, now: 2_000 });
  return { result, accountsDb, controlDb };
}

async function validEvidence() {
  const sessionHash = await hashSessionIdWithSalt(SESSION_ID, SESSION_SALT);
  return {
    accounts: [
      {
        session_key: sessionHash,
        session_json: JSON.stringify({
          sessionId: sessionHash,
          subject: SUBJECT,
          createdAt: 1_000,
          expiresAt: 3_000,
        }),
        account_key: SUBJECT,
        account_json: JSON.stringify({
          subject: SUBJECT,
          createdAt: 500,
          updatedAt: 1_500,
        }),
      },
    ],
    membership: [membershipRow()],
    control: [controlRow()],
  };
}

function membershipRow(patch: { roles?: readonly string[] } = {}) {
  const record = membershipRecord(patch.roles);
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    account_id: record.accountId,
    status: record.status,
    record_json: JSON.stringify(record),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function membershipRecord(roles: readonly string[] = ["owner"]) {
  return {
    id: "wsm_workspace_bootstrap",
    workspaceId: WORKSPACE_ID,
    accountId: SUBJECT,
    roles,
    status: "active",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function workspaceRecord() {
  return {
    id: WORKSPACE_ID,
    handle: "workspace-bootstrap",
    displayName: "Workspace Bootstrap",
    type: "personal",
    ownerUserId: SUBJECT,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function projectRecord() {
  return {
    id: defaultProjectId(WORKSPACE_ID),
    workspaceId: WORKSPACE_ID,
    name: "Default",
    slug: "default",
    projectJson: {},
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function controlRow() {
  const workspace = workspaceRecord();
  const project = projectRecord();
  return {
    workspace_id: workspace.id,
    workspace_handle: workspace.handle,
    workspace_record_json: JSON.stringify(workspace),
    workspace_created_at: workspace.createdAt,
    workspace_updated_at: workspace.updatedAt,
    project_id: project.id,
    project_workspace_id: project.workspaceId,
    project_name: project.name,
    project_slug: project.slug,
    project_record_json: JSON.stringify(project),
    project_created_at: project.createdAt,
    project_updated_at: project.updatedAt,
  };
}

function assertNoWrites(db: CountingD1) {
  expect(db.firstCalls).toBe(0);
  expect(db.runCalls).toBe(0);
  expect(db.batchCalls).toBe(0);
  expect(db.execCalls).toBe(0);
}

class CountingD1 implements D1Database {
  readonly prepared: string[] = [];
  readonly bound: D1Value[][] = [];
  allCalls = 0;
  firstCalls = 0;
  runCalls = 0;
  batchCalls = 0;
  execCalls = 0;
  failure: unknown;
  failureOnCall: number | undefined;
  result: D1Result | undefined;
  resultOnCall: number | undefined;
  #reads: Array<readonly unknown[]>;

  constructor(reads: readonly (readonly unknown[])[]) {
    this.#reads = reads.map((rows) => [...rows]);
  }

  prepare(query: string): D1PreparedStatement {
    this.prepared.push(query);
    return new CountingStatement(this, this.#reads.shift() ?? []);
  }

  async batch<T = unknown>(
    _statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.batchCalls += 1;
    return [];
  }

  async exec(_query: string): Promise<D1ExecResult> {
    this.execCalls += 1;
    return { count: 0, duration: 0 };
  }
}

class CountingStatement implements D1PreparedStatement {
  constructor(
    readonly db: CountingD1,
    readonly rows: readonly unknown[],
  ) {}

  bind(...values: readonly D1Value[]): D1PreparedStatement {
    this.db.bound.push([...values]);
    return this;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    this.db.allCalls += 1;
    if (
      this.db.failure !== undefined &&
      (this.db.failureOnCall === undefined ||
        this.db.failureOnCall === this.db.allCalls)
    ) {
      throw this.db.failure;
    }
    if (
      this.db.result &&
      (this.db.resultOnCall === undefined ||
        this.db.resultOnCall === this.db.allCalls)
    ) {
      return this.db.result as D1Result<T>;
    }
    return { success: true, results: [...this.rows] as T[] };
  }

  async first<T = unknown>(_column?: string): Promise<T | null> {
    this.db.firstCalls += 1;
    return null;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    this.db.runCalls += 1;
    return { success: true };
  }
}
