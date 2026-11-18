/** Host-only receipt capability. No public request field or execution fallback. */
import type { DispatchStateScope } from "@takosumi/internal/deploy-control-api";
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
