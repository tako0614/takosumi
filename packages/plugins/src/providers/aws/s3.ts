import type { objectStorage } from "takosumi-contract";
import type {
  AwsObjectStorageClient,
  AwsObjectStorageDeleteRequest,
  AwsObjectStorageGetRequest,
  AwsObjectStorageHeadRequest,
  AwsObjectStorageListRequest,
  AwsObjectStoragePutRequest,
} from "./clients.ts";
import {
  type AwsRetryConfig,
  classifyAwsError,
  detectDrift,
  type DriftField,
  withRetry,
} from "./support.ts";

/**
 * `provider.aws.s3@v1` — S3 bucket lifecycle + IAM-aware object access.
 *
 * For data plane object I/O the kernel uses {@link AwsObjectStorageClient}.
 * This module adds the descriptor-side bucket lifecycle (create / configure /
 * delete) plus narrow IAM policy attachment that the resource subsystem
 * invokes.
 *
 * Production-grade behaviour:
 *  - retry / backoff on throttling / 5xx
 *  - `not-found` is mapped to `undefined` for `describeBucket`
 *  - paginated `listObjects` (continuationToken-based)
 *  - drift detection between desired and observed bucket configuration
 */
export interface AwsS3BucketCreateInput {
  readonly bucketName: string;
  readonly region?: string;
  readonly versioningEnabled?: boolean;
  readonly publicAccessBlockEnabled?: boolean;
  readonly defaultEncryption?: AwsS3DefaultEncryption;
  readonly tags?: Record<string, string>;
}

export interface AwsS3DefaultEncryption {
  readonly algorithm: "AES256" | "aws:kms";
  readonly kmsKeyArn?: string;
}

export interface AwsS3BucketDescriptor {
  readonly bucketName: string;
  readonly arn: string;
  readonly region?: string;
  readonly versioningEnabled?: boolean;
  readonly publicAccessBlockEnabled?: boolean;
  readonly defaultEncryption?: AwsS3DefaultEncryption;
  readonly tags?: Record<string, string>;
}

export interface AwsS3BucketDescribeInput {
  readonly bucketName: string;
}

export interface AwsS3BucketDeleteInput {
  readonly bucketName: string;
  readonly emptyBeforeDelete?: boolean;
}

export interface AwsS3IamPolicyAttachInput {
  readonly bucketName: string;
  readonly principalArn: string;
  readonly accessLevel: "read" | "read-write" | "admin";
  readonly policyName?: string;
}

export interface AwsS3IamPolicyAttachResult {
  readonly policyArn: string;
  readonly policyName: string;
  readonly attachedAt: string;
}

export interface AwsS3LifecycleClient {
  createBucket(
    input: AwsS3BucketCreateInput,
  ): Promise<AwsS3BucketDescriptor>;
  describeBucket(
    input: AwsS3BucketDescribeInput,
  ): Promise<AwsS3BucketDescriptor | undefined>;
  deleteBucket(input: AwsS3BucketDeleteInput): Promise<boolean>;
  attachIamPolicy?(
    input: AwsS3IamPolicyAttachInput,
  ): Promise<AwsS3IamPolicyAttachResult>;
}

export interface AwsS3ProviderOptions {
  readonly lifecycle: AwsS3LifecycleClient;
  readonly objectStorage?: AwsObjectStorageClient;
  readonly retry?: Partial<AwsRetryConfig>;
}

/**
 * `provider.aws.s3@v1` materializer. Manages bucket lifecycle through the
 * lifecycle client and (optionally) forwards object I/O through an injected
 * `AwsObjectStorageClient`.
 */
export class AwsS3Provider {
  readonly #lifecycle: AwsS3LifecycleClient;
  readonly #objectStorage?: AwsObjectStorageClient;
  readonly #retry?: Partial<AwsRetryConfig>;

  constructor(options: AwsS3ProviderOptions) {
    this.#lifecycle = options.lifecycle;
    this.#objectStorage = options.objectStorage;
    this.#retry = options.retry;
  }

  createBucket(
    input: AwsS3BucketCreateInput,
  ): Promise<AwsS3BucketDescriptor> {
    return withRetry(
      "aws-s3-create-bucket",
      () => this.#lifecycle.createBucket(input),
      this.#retry,
    );
  }

  async describeBucket(
    input: AwsS3BucketDescribeInput,
  ): Promise<AwsS3BucketDescriptor | undefined> {
    try {
      return await withRetry(
        "aws-s3-describe-bucket",
        () => this.#lifecycle.describeBucket(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  deleteBucket(input: AwsS3BucketDeleteInput): Promise<boolean> {
    return withRetry(
      "aws-s3-delete-bucket",
      () => this.#lifecycle.deleteBucket(input),
      this.#retry,
    );
  }

  attachIamPolicy(
    input: AwsS3IamPolicyAttachInput,
  ): Promise<AwsS3IamPolicyAttachResult> {
    if (!this.#lifecycle.attachIamPolicy) {
      throw new Error(
        "AwsS3LifecycleClient does not implement attachIamPolicy; cannot attach IAM policy",
      );
    }
    return withRetry(
      "aws-s3-attach-iam",
      () => this.#lifecycle.attachIamPolicy!(input),
      this.#retry,
    );
  }

  putObject(
    input: AwsObjectStoragePutRequest,
  ): Promise<objectStorage.ObjectStorageObjectHead> {
    return withRetry(
      "aws-s3-put-object",
      () => this.#requireObjectStorage().putObject(input),
      this.#retry,
    );
  }

  async getObject(
    input: AwsObjectStorageGetRequest,
  ): Promise<objectStorage.ObjectStorageObject | undefined> {
    try {
      return await withRetry(
        "aws-s3-get-object",
        () => this.#requireObjectStorage().getObject(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  async headObject(
    input: AwsObjectStorageHeadRequest,
  ): Promise<objectStorage.ObjectStorageObjectHead | undefined> {
    try {
      return await withRetry(
        "aws-s3-head-object",
        () => this.#requireObjectStorage().headObject(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  listObjects(
    input: AwsObjectStorageListRequest,
  ): Promise<objectStorage.ObjectStorageListResult> {
    return withRetry(
      "aws-s3-list-objects",
      () => this.#requireObjectStorage().listObjects(input),
      this.#retry,
    );
  }

  /**
   * Iterates ALL objects under `prefix`, following the continuation token
   * across pages. Each page is retried independently. Use only for bounded
   * scans (kernel-side enumeration jobs).
   */
  async listAllObjects(
    input: Omit<AwsObjectStorageListRequest, "continuationToken">,
  ): Promise<readonly objectStorage.ObjectStorageObjectHead[]> {
    const out: objectStorage.ObjectStorageObjectHead[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listObjects({
        ...input,
        continuationToken: cursor,
      });
      for (const obj of page.objects) out.push(obj);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  deleteObject(input: AwsObjectStorageDeleteRequest): Promise<boolean> {
    return withRetry(
      "aws-s3-delete-object",
      () => this.#requireObjectStorage().deleteObject(input),
      this.#retry,
    );
  }

  /**
   * Compares desired vs observed bucket configuration. Returns drift fields
   * (versioning, public access block, default encryption, region).
   */
  async detectDrift(
    desired: AwsS3BucketCreateInput,
  ): Promise<readonly DriftField[]> {
    const observed = await this.describeBucket({
      bucketName: desired.bucketName,
    });
    if (!observed) {
      return [{ path: "$", desired, observed: undefined }];
    }
    const desiredSubset = {
      bucketName: desired.bucketName,
      region: desired.region,
      versioningEnabled: desired.versioningEnabled,
      publicAccessBlockEnabled: desired.publicAccessBlockEnabled,
      defaultEncryption: desired.defaultEncryption,
    };
    const observedSubset = {
      bucketName: observed.bucketName,
      region: observed.region,
      versioningEnabled: observed.versioningEnabled,
      publicAccessBlockEnabled: observed.publicAccessBlockEnabled,
      defaultEncryption: observed.defaultEncryption,
    };
    return detectDrift(desiredSubset, observedSubset);
  }

  #requireObjectStorage(): AwsObjectStorageClient {
    if (!this.#objectStorage) {
      throw new Error(
        "AwsS3Provider was not constructed with an objectStorage client; inject AwsObjectStorageClient to perform object I/O",
      );
    }
    return this.#objectStorage;
  }
}
