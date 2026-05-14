export interface CloudflareWorkerEnv extends Record<string, unknown> {
  readonly TAKOS_D1: D1Database;
  readonly TAKOS_ARTIFACTS: R2Bucket;
  readonly TAKOS_QUEUE?: Queue<unknown>;
  readonly TAKOS_COORDINATION: DurableObjectNamespace;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]>;
}

export interface D1PreparedStatement {
  bind(...values: readonly unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Result<T = unknown> {
  readonly results?: readonly T[];
  readonly success?: boolean;
  readonly meta?: {
    readonly changes?: number;
    readonly last_row_id?: number;
    readonly rows_read?: number;
    readonly rows_written?: number;
  };
}

export interface R2Bucket {
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions,
  ): Promise<R2Object>;
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  list(options?: R2ListOptions): Promise<R2Objects>;
  delete(key: string): Promise<void>;
}

export interface R2PutOptions {
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

export interface R2ListOptions {
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface R2Objects {
  readonly objects: readonly R2Object[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface R2Object {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: {
    readonly contentType?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface Queue<T> {
  send(message: T): Promise<void>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
