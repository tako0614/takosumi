export type OperatorConfigSource = "env" | "local";

export interface OperatorConfigSecretRef {
  readonly name: string;
  readonly version?: string;
}

export type OperatorConfigValue =
  | {
    readonly kind: "plain";
    readonly key: string;
    readonly source: OperatorConfigSource;
    readonly value: string;
  }
  | {
    readonly kind: "secret-ref";
    readonly key: string;
    readonly source: OperatorConfigSource;
    readonly ref: OperatorConfigSecretRef;
    readonly redacted: true;
  };

export interface OperatorConfigSnapshot {
  readonly generatedAt: string;
  readonly values: readonly OperatorConfigValue[];
}

export interface OperatorConfigPort {
  get(key: string): Promise<OperatorConfigValue | undefined>;
  require(key: string): Promise<OperatorConfigValue>;
  snapshot(): Promise<OperatorConfigSnapshot>;
}

export type LocalOperatorConfigInputValue = string | OperatorConfigSecretRef;
