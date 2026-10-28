import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  personalAccessTokenStoredAppIdsAreWellFormed,
  type AccountsStore,
  type PersonalAccessTokenAppAttenuation,
  type PersonalAccessTokenInventoryCursor,
} from "./store.ts";

/** The Control implementation must return every non-destroyed Capsule in this Workspace. */
export interface TrustedWorkspaceAppInventory {
  listWorkspaceApps(workspaceId: string): Promise<{
    readonly workspaceId: string;
    readonly appIds: readonly string[];
  }>;
}

export interface WorkspacePatAppConversionPlan {
  readonly kind: "takosumi.pat-workspace-app-conversion@v1";
  readonly reviewedSubjects: readonly TakosumiSubject[];
  readonly workspaceSnapshots: readonly {
    readonly workspaceId: string;
    readonly appIds: readonly string[];
  }[];
  /** Public PAT IDs only. Bearer token strings are never read. */
  readonly tokens: readonly PersonalAccessTokenAppAttenuation[];
}

export class WorkspacePatAppConversionConflict extends Error {
  constructor(readonly converted: number) {
    super("PAT app conversion source changed; run a new dry-run before resuming");
    this.name = "WorkspacePatAppConversionConflict";
  }
}

function reviewedSubjects(subjects: readonly TakosumiSubject[]): readonly TakosumiSubject[] {
  if (subjects.length === 0 || subjects.length > 10_000 ||
    subjects.some((subject) => typeof subject !== "string" || !/^tsub_[^\s]+$/u.test(subject) || subject.length > 256) ||
    new Set(subjects).size !== subjects.length) throw new TypeError("Reviewed account IDs are invalid");
  return [...subjects].sort();
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Credential-free dry-run: reads only PAT metadata and trusted Control IDs. */
export async function dryRunWorkspacePatAppConversion(input: {
  readonly store: AccountsStore;
  readonly reviewedSubjects: readonly TakosumiSubject[];
  readonly inventory: TrustedWorkspaceAppInventory;
}): Promise<WorkspacePatAppConversionPlan> {
  const subjects = reviewedSubjects(input.reviewedSubjects);
  const snapshots = new Map<string, readonly string[]>();
  const tokens: PersonalAccessTokenAppAttenuation[] = [];
  for (const subject of subjects) {
    let cursor: PersonalAccessTokenInventoryCursor | undefined;
    for (;;) {
      const page = await input.store.listPersonalAccessTokenInventoryPage({ subject, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!page.cursorValid || page.items.length > 101) throw new Error("PAT inventory changed during dry-run");
      const items = page.items.slice(0, 100);
      for (const record of items) {
        if (record.subject !== subject || !record.tokenId) throw new Error("PAT inventory subject is inconsistent");
        if (!record.workspaceId || record.appIds !== undefined) continue;
        let appIds = snapshots.get(record.workspaceId);
        if (appIds === undefined) {
          const snapshot = await input.inventory.listWorkspaceApps(record.workspaceId);
          if (snapshot.workspaceId !== record.workspaceId ||
            !personalAccessTokenStoredAppIdsAreWellFormed(snapshot.appIds)) {
            throw new Error("Control Workspace app inventory is inconsistent");
          }
          appIds = [...snapshot.appIds].sort();
          snapshots.set(record.workspaceId, appIds);
        }
        tokens.push({ subject, tokenId: record.tokenId, expectedWorkspaceId: record.workspaceId, appIds });
      }
      if (page.items.length <= 100) break;
      const last = items[items.length - 1];
      if (!last || (cursor && (last.createdAt < cursor.createdAt ||
        (last.createdAt === cursor.createdAt && last.tokenId <= cursor.tokenId)))) {
        throw new Error("PAT inventory cursor did not advance");
      }
      cursor = { createdAt: last.createdAt, tokenId: last.tokenId };
    }
  }
  return {
    kind: "takosumi.pat-workspace-app-conversion@v1",
    reviewedSubjects: subjects,
    workspaceSnapshots: [...snapshots].sort(([a], [b]) => a.localeCompare(b))
      .map(([workspaceId, appIds]) => ({ workspaceId, appIds })),
    tokens,
  };
}

/** Rechecks the reviewed snapshot, then applies one exact durable CAS per PAT. */
export async function applyWorkspacePatAppConversion(input: {
  readonly store: AccountsStore;
  readonly plan: WorkspacePatAppConversionPlan;
  readonly inventory: TrustedWorkspaceAppInventory;
}): Promise<{ readonly converted: number }> {
  if (!input.store.attenuatePersonalAccessTokenApps) throw new Error("PAT app attenuation store operation is unavailable");
  const fresh = await dryRunWorkspacePatAppConversion({
    store: input.store,
    reviewedSubjects: input.plan.reviewedSubjects,
    inventory: input.inventory,
  });
  if (!same(fresh, input.plan)) throw new WorkspacePatAppConversionConflict(0);
  let converted = 0;
  for (const token of fresh.tokens) {
    if (!(await input.store.attenuatePersonalAccessTokenApps(token))) {
      throw new WorkspacePatAppConversionConflict(converted);
    }
    converted++;
  }
  return { converted };
}
