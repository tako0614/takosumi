import type { ReferenceDeploySourcePayload } from "../../domains/deploy/mod.ts";

export type SourceSnapshotKind = "source" | "git" | "local_upload";

export interface SourceFileSnapshot {
  readonly path: string;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface SourceSnapshot {
  readonly id: string;
  readonly kind: SourceSnapshotKind;
  readonly source: ReferenceDeploySourcePayload;
  readonly files: readonly SourceFileSnapshot[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly immutable: true;
}

export interface SourcePort<TInput = unknown> {
  snapshot(input: TInput): Promise<SourceSnapshot>;
}
