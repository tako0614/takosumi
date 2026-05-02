export type ObjectStorageDigest = `sha256:${string}`;

export interface ObjectStorageLocation {
  readonly bucket: string;
  readonly key: string;
}

export interface ObjectStoragePutInput extends ObjectStorageLocation {
  readonly body: Uint8Array | string;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
  readonly expectedDigest?: ObjectStorageDigest;
}

export interface ObjectStorageGetInput extends ObjectStorageLocation {
  readonly expectedDigest?: ObjectStorageDigest;
}

export interface ObjectStorageHeadInput extends ObjectStorageLocation {
  readonly expectedDigest?: ObjectStorageDigest;
}

export interface ObjectStorageListInput {
  readonly bucket: string;
  readonly prefix?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ObjectStorageDeleteInput extends ObjectStorageLocation {}

export interface ObjectStorageObjectHead extends ObjectStorageLocation {
  readonly contentLength: number;
  readonly contentType?: string;
  readonly metadata: Record<string, string>;
  readonly digest: ObjectStorageDigest;
  readonly etag: string;
  readonly updatedAt: string;
}

export interface ObjectStorageObject extends ObjectStorageObjectHead {
  readonly body: Uint8Array;
}

export interface ObjectStorageListResult {
  readonly objects: readonly ObjectStorageObjectHead[];
  readonly nextCursor?: string;
}

export interface ObjectStoragePort {
  putObject(input: ObjectStoragePutInput): Promise<ObjectStorageObjectHead>;
  getObject(
    input: ObjectStorageGetInput,
  ): Promise<ObjectStorageObject | undefined>;
  headObject(
    input: ObjectStorageHeadInput,
  ): Promise<ObjectStorageObjectHead | undefined>;
  listObjects(input: ObjectStorageListInput): Promise<ObjectStorageListResult>;
  deleteObject(input: ObjectStorageDeleteInput): Promise<boolean>;
}

export class ObjectStorageDigestMismatchError extends Error {
  constructor(
    readonly expectedDigest: ObjectStorageDigest,
    readonly actualDigest: ObjectStorageDigest,
  ) {
    super(
      `object storage digest mismatch: expected ${expectedDigest}, got ${actualDigest}`,
    );
    this.name = "ObjectStorageDigestMismatchError";
  }
}
