/**
 * `DirectAwsS3Lifecycle` — calls AWS S3 REST API directly via SigV4-signed
 * fetch. Operators provide `accessKeyId` / `secretAccessKey` / `region` and
 * the runtime-agent reaches AWS in-process.
 */

import {
  type AwsSigV4Credentials,
  ensureAwsResponseOk,
  sigv4Fetch,
} from "../../_aws_sigv4.ts";

export interface AwsS3BucketCreateInput {
  readonly bucketName: string;
  readonly region?: string;
  readonly versioningEnabled?: boolean;
  readonly publicAccessBlockEnabled?: boolean;
}

export interface AwsS3BucketDescriptor {
  readonly bucketName: string;
  readonly arn: string;
  readonly region?: string;
  readonly versioningEnabled?: boolean;
  readonly publicAccessBlockEnabled?: boolean;
}

export interface AwsS3BucketDescribeInput {
  readonly bucketName: string;
}

export interface AwsS3BucketDeleteInput {
  readonly bucketName: string;
  readonly emptyBeforeDelete?: boolean;
}

export interface DirectAwsS3LifecycleOptions {
  readonly credentials: AwsSigV4Credentials;
  readonly region: string;
  readonly fetch?: typeof fetch;
}

export class DirectAwsS3Lifecycle {
  readonly #credentials: AwsSigV4Credentials;
  readonly #region: string;
  readonly #fetch?: typeof fetch;

  constructor(options: DirectAwsS3LifecycleOptions) {
    this.#credentials = options.credentials;
    this.#region = options.region;
    this.#fetch = options.fetch;
  }

  async createBucket(
    input: AwsS3BucketCreateInput,
  ): Promise<AwsS3BucketDescriptor> {
    const region = input.region ?? this.#region;
    const url = bucketUrl(input.bucketName, region);
    const body = region === "us-east-1" ? "" : createBucketXml(region);
    const response = await sigv4Fetch(
      {
        method: "PUT",
        url,
        service: "s3",
        region,
        headers: body ? { "content-type": "application/xml" } : undefined,
        body,
      },
      { credentials: this.#credentials, fetch: this.#fetch },
    );
    if (!response.ok && response.status !== 409) {
      // 409 = BucketAlreadyOwnedByYou: idempotent path
      await ensureAwsResponseOk(
        response,
        `s3:CreateBucket ${input.bucketName}`,
      );
    }
    if (input.versioningEnabled) {
      await this.#putBucketVersioning(input.bucketName, region, true);
    }
    if (input.publicAccessBlockEnabled) {
      await this.#putPublicAccessBlock(input.bucketName, region);
    }
    return {
      bucketName: input.bucketName,
      arn: `arn:aws:s3:::${input.bucketName}`,
      region,
      versioningEnabled: input.versioningEnabled ?? false,
      publicAccessBlockEnabled: input.publicAccessBlockEnabled ?? true,
    };
  }

  async describeBucket(
    input: AwsS3BucketDescribeInput,
  ): Promise<AwsS3BucketDescriptor | undefined> {
    const url = bucketUrl(input.bucketName, this.#region);
    const response = await sigv4Fetch(
      {
        method: "HEAD",
        url,
        service: "s3",
        region: this.#region,
      },
      { credentials: this.#credentials, fetch: this.#fetch },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      await ensureAwsResponseOk(response, `s3:HeadBucket ${input.bucketName}`);
    }
    return {
      bucketName: input.bucketName,
      arn: `arn:aws:s3:::${input.bucketName}`,
      region: response.headers.get("x-amz-bucket-region") ?? this.#region,
    };
  }

  async deleteBucket(input: AwsS3BucketDeleteInput): Promise<boolean> {
    const url = bucketUrl(input.bucketName, this.#region);
    if (input.emptyBeforeDelete) {
      // Best-effort: skip object enumeration here (kept minimal for v0).
    }
    const response = await sigv4Fetch(
      {
        method: "DELETE",
        url,
        service: "s3",
        region: this.#region,
      },
      { credentials: this.#credentials, fetch: this.#fetch },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      await ensureAwsResponseOk(
        response,
        `s3:DeleteBucket ${input.bucketName}`,
      );
    }
    return true;
  }

  async #putBucketVersioning(
    bucketName: string,
    region: string,
    enabled: boolean,
  ): Promise<void> {
    const url = `${bucketUrl(bucketName, region)}?versioning`;
    const body =
      `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${
        enabled ? "Enabled" : "Suspended"
      }</Status></VersioningConfiguration>`;
    const response = await sigv4Fetch(
      {
        method: "PUT",
        url,
        service: "s3",
        region,
        headers: { "content-type": "application/xml" },
        body,
      },
      { credentials: this.#credentials, fetch: this.#fetch },
    );
    await ensureAwsResponseOk(
      response,
      `s3:PutBucketVersioning ${bucketName}`,
    );
  }

  async #putPublicAccessBlock(
    bucketName: string,
    region: string,
  ): Promise<void> {
    const url = `${bucketUrl(bucketName, region)}?publicAccessBlock`;
    const body =
      `<PublicAccessBlockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>`;
    const response = await sigv4Fetch(
      {
        method: "PUT",
        url,
        service: "s3",
        region,
        headers: { "content-type": "application/xml" },
        body,
      },
      { credentials: this.#credentials, fetch: this.#fetch },
    );
    await ensureAwsResponseOk(
      response,
      `s3:PutPublicAccessBlock ${bucketName}`,
    );
  }
}

function bucketUrl(bucket: string, region: string): string {
  if (region === "us-east-1") return `https://${bucket}.s3.amazonaws.com/`;
  return `https://${bucket}.s3.${region}.amazonaws.com/`;
}

function createBucketXml(region: string): string {
  return `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
}
