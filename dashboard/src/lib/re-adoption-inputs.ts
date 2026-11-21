import type { CapsuleAppView, CapsuleInstallConfigReAdoptionInputContext, JsonValue } from "takosumi-contract";
import { ControlApiError } from "./control-api.ts";

/** The server binds this optional locator to the latest failed revision Plan. */
export function reAdoptionRevisionFromApp(app: CapsuleAppView | undefined): string | undefined {
  const run = app?.latestRun;
  return run?.type === "plan" && run.status === "failed" && typeof run.revisionPlanId === "string" && run.revisionPlanId.length > 0
    ? run.revisionPlanId : undefined;
}

/** Only a structured, same-app/source target can offer its input context. */
export function reAdoptionRevisionFromError(cause: unknown, capsuleId: string, sourceId: string | undefined): string | undefined {
  if (!(cause instanceof ControlApiError) || !sourceId || !cause.body || typeof cause.body !== "object") return undefined;
  const body = cause.body as { nextAction?: unknown; revisionPlan?: {
    id?: unknown; operation?: unknown; capsuleId?: unknown; sourceId?: unknown; sourceSnapshotId?: unknown;
    phase?: unknown; revision?: { targetRef?: unknown };
  } };
  const plan = body.revisionPlan;
  if (!plan || plan.operation !== "revision" || plan.capsuleId !== capsuleId || plan.sourceId !== sourceId ||
    typeof plan.id !== "string" || !plan.id || typeof plan.sourceSnapshotId !== "string" || !plan.sourceSnapshotId ||
    typeof plan.revision?.targetRef !== "string" || !plan.revision.targetRef) return undefined;
  return plan.phase === "failed" || (cause.code === "re_adoption_target_changed" && body.nextAction === "review_run")
    ? plan.id : undefined;
}

export interface ReAdoptionInputDraft {
  readonly mode: "keep" | "set" | "unset" | "unresolved";
  readonly text: string;
}
export type ReAdoptionInputDrafts = Readonly<Record<string, ReAdoptionInputDraft>>;

function text(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function initialReAdoptionDrafts(context: CapsuleInstallConfigReAdoptionInputContext): ReAdoptionInputDrafts {
  return Object.fromEntries(context.variables.map(variable => [variable.name, {
    mode: variable.currentValue.status === "present" ? "keep"
      : variable.currentValue.status === "unavailable" ? "unresolved" : variable.required ? "set" : "unset",
    text: variable.currentValue.status === "present" ? text(variable.currentValue.value) : "",
  }]));
}

function finiteJson(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite JSON");
  return value;
}

function matches(value: JsonValue, type: string): boolean {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean" || type === "string") return typeof value === type;
  if (type !== "json") return false;
  try { return JSON.stringify(value, finiteJson) !== undefined; } catch { return false; }
}

/** Complete user replacement: absent optional values are intentionally unset. */
export function buildReAdoptionInputs(context: CapsuleInstallConfigReAdoptionInputContext, drafts: ReAdoptionInputDrafts) {
  const missing: string[] = [], invalid: string[] = [];
  const names = new Set<string>();
  const values: Array<readonly [string, JsonValue]> = [];
  for (const variable of context.variables) {
    if (names.has(variable.name) || variable.userEditable !== true || variable.sensitive !== false ||
      !["string", "number", "boolean", "json"].includes(variable.type)) {
      invalid.push(variable.name);
      continue;
    }
    names.add(variable.name);
    const draft = drafts[variable.name];
    let value: JsonValue | undefined;
    if (draft?.mode === "keep") {
      if (variable.currentValue.status === "present") value = variable.currentValue.value;
      else if (variable.currentValue.status !== "unset") invalid.push(variable.name);
    } else if (draft?.mode === "unset") {
      // Deliberate omission, including an explicit removal of an old value.
    } else if (draft?.mode === "set") {
      if (variable.required && draft.text === "") missing.push(variable.name);
      else try {
        value = variable.type === "string" ? draft.text
          : variable.type === "number" ? draft.text.trim() ? Number(draft.text) : undefined
          : variable.type === "boolean" ? draft.text === "true" ? true : draft.text === "false" ? false : undefined
          : variable.type === "json" ? JSON.parse(draft.text, finiteJson) as JsonValue : undefined;
        if (value === undefined) invalid.push(variable.name);
      } catch { invalid.push(variable.name); }
    } else invalid.push(variable.name);
    if (value !== undefined) {
      if (matches(value, variable.type)) values.push([variable.name, value]);
      else invalid.push(variable.name);
    } else if (variable.required && !missing.includes(variable.name) && !invalid.includes(variable.name)) missing.push(variable.name);
  }
  for (const name of Object.keys(drafts)) if (!names.has(name)) invalid.push(name);
  return !context.blockedReason && missing.length === 0 && invalid.length === 0
    ? { ok: true as const, variables: Object.fromEntries(values) as Readonly<Record<string, JsonValue>> }
    : { ok: false as const, missing, invalid, blocked: context.blockedReason !== undefined };
}
