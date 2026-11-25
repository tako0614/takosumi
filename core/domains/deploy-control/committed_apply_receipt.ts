/** Host-only receipt capability. No public request field or execution fallback. */
import type { DispatchStateScope } from "@takosumi/internal/deploy-control-api";
import type { RunExecutionAuthority } from "takosumi-contract/runs";
import type { OpenTofuApplyResult, OpenTofuRunner } from "./mod.ts";

declare const receiptCommand: unique symbol;
export interface CommittedApplyReceiptCommand { readonly [receiptCommand]: true }

interface Receipt {
  readonly runner: OpenTofuRunner;
  readonly runId: string;
  readonly stateScope: DispatchStateScope;
  readonly result: OpenTofuApplyResult;
  /** Concrete custody closure; success confirms only Core's exact raw ref. */
  readonly confirm: (rawOutputRef: string) => Promise<OpenTofuApplyResult>;
}
const receipts = new WeakMap<CommittedApplyReceiptCommand, Receipt>();

/** Only an explicitly trusted adapter holding authenticated durable bytes calls this. */
export function committedApplyReceiptCommand(input: Receipt): CommittedApplyReceiptCommand {
  const command = Object.freeze({}) as CommittedApplyReceiptCommand;
  receipts.set(command, { ...input, stateScope: structuredClone(input.stateScope), result: structuredClone(input.result) });
  return command;
}

/** An unknown command is a refusal, never permission to execute normally. */
export function readCommittedApplyReceiptCommand(
  command: CommittedApplyReceiptCommand,
  runner: OpenTofuRunner,
  runId: string,
): Readonly<Receipt> | undefined {
  const receipt = receipts.get(command);
  return receipt?.runner === runner && receipt.runId === runId ? receipt : undefined;
}

/** Host-only, run-bound observation. It is never a public dispatch option. */
declare const receiptProbe: unique symbol;
export interface CommittedApplyReceiptProbeCommand { readonly [receiptProbe]: true }
type ExecutionArtifacts = Pick<RunExecutionAuthority, "controllerArtifact" | "runnerArtifact" | "executorArtifact">;
interface ReceiptProbe {
  readonly runner: OpenTofuRunner;
  readonly runId: string;
  /** An unqualified observation may never fall through to ordinary execution. */
  readonly settlementOnly?: true;
  /** An uncertain dispatch preserves the Run when its prepared inputs cannot be read. Both ordinary and uncertain dispatch still rely on the runner's preparation fence. */
  readonly inspect: (action: "apply" | "destroy") => Promise<"ordinary" | "dispatch_uncertain" | "completed" | "hold">;
  /** Core allocates the immutable state coordinate and any Apply output. */
  readonly read: (allocation: { readonly stateScope: DispatchStateScope; readonly rawOutputRef?: string }) => Promise<{
    readonly result: OpenTofuApplyResult;
    /** Independently recorded on admission, before the dispatch wrote a result. */
    readonly admittedExecutionAuthority?: ExecutionArtifacts;
  } | undefined>;
}
const probes = new WeakMap<CommittedApplyReceiptProbeCommand, Readonly<ReceiptProbe>>();
export function committedApplyReceiptProbeCommand(input: ReceiptProbe): CommittedApplyReceiptProbeCommand {
  const command = Object.freeze({}) as CommittedApplyReceiptProbeCommand;
  probes.set(command, Object.freeze({ ...input }));
  return command;
}
export function readCommittedApplyReceiptProbeCommand(command: CommittedApplyReceiptProbeCommand, runId: string): Readonly<ReceiptProbe> | undefined {
  const probe = probes.get(command);
  return probe?.runId === runId ? probe : undefined;
}
