import type { PublicDeployManifest } from "../../domains/deploy/mod.ts";

export type SourceSnapshotKind = "manifest" | "git" | "local_upload";

export interface SourceFileSnapshot {
  readonly path: string;
  readonly contentType?: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

export interface SourceSnapshot {
  readonly id: string;
  readonly kind: SourceSnapshotKind;
  readonly manifest: PublicDeployManifest;
  readonly files: readonly SourceFileSnapshot[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly immutable: true;
}

export interface SourcePort<TInput = unknown> {
  snapshot(input: TInput): Promise<SourceSnapshot>;
}
