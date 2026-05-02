/**
 * `DirectGcsLifecycle` — calls GCP Cloud Storage REST API directly.
 *
 * Auth: bearer token (operator-supplied) or service-account JSON via
 * GcpAccessTokenProvider.
 *
 * Endpoint: https://storage.googleapis.com/storage/v1/b
 */

import {
  ensureGcpResponseOk,
  GcpAccessTokenProvider,
  type GcpAccessTokenProviderOptions,
  gcpJsonFetch,
} from "../../_gcp_auth.ts";

export interface GcsBucketDescriptor {
  readonly project: string;
  readonly bucketName: string;
  readonly location: string;
  readonly resourceName: string;
}

export interface GcsCreateBucketInput {
  readonly bucketName: string;
  readonly location?: string;
  readonly versioning?: boolean;
  readonly publicAccess?: boolean;
}

export interface DirectGcsLifecycleOptions
  extends GcpAccessTokenProviderOptions {
  readonly project: string;
  readonly defaultLocation?: string;
}

export class DirectGcsLifecycle {
  readonly #project: string;
  readonly #tokens: GcpAccessTokenProvider;
  readonly #fetch?: typeof fetch;
  readonly #defaultLocation: string;

  constructor(options: DirectGcsLifecycleOptions) {
    this.#project = options.project;
    this.#tokens = new GcpAccessTokenProvider(options);
    this.#fetch = options.fetch;
    this.#defaultLocation = options.defaultLocation ?? "US";
  }

  async createBucket(
    input: GcsCreateBucketInput,
  ): Promise<GcsBucketDescriptor> {
    const body = {
      name: input.bucketName,
      location: input.location ?? this.#defaultLocation,
      versioning: { enabled: input.versioning ?? false },
      iamConfiguration: {
        publicAccessPrevention: input.publicAccess ? "inherited" : "enforced",
      },
    };
    const result = await gcpJsonFetch<{ name?: string; location?: string }>(
      this.#tokens,
      {
        method: "POST",
        url: `https://storage.googleapis.com/storage/v1/b?project=${
          encodeURIComponent(this.#project)
        }`,
        body,
        fetch: this.#fetch,
      },
    );
    if (result.status === 409) {
      // Bucket already exists; treat as idempotent
    } else {
      ensureGcpResponseOk(result, `gcs:CreateBucket ${input.bucketName}`);
    }
    return {
      project: this.#project,
      bucketName: input.bucketName,
      location: result.json?.location ?? input.location ??
        this.#defaultLocation,
      resourceName: `projects/${this.#project}/buckets/${input.bucketName}`,
    };
  }

  async describeBucket(
    input: { readonly bucketName: string },
  ): Promise<GcsBucketDescriptor | undefined> {
    const result = await gcpJsonFetch<{ name?: string; location?: string }>(
      this.#tokens,
      {
        method: "GET",
        url: `https://storage.googleapis.com/storage/v1/b/${
          encodeURIComponent(input.bucketName)
        }`,
        fetch: this.#fetch,
      },
    );
    if (result.status === 404) return undefined;
    ensureGcpResponseOk(result, `gcs:GetBucket ${input.bucketName}`);
    return {
      project: this.#project,
      bucketName: input.bucketName,
      location: result.json?.location ?? this.#defaultLocation,
      resourceName: `projects/${this.#project}/buckets/${input.bucketName}`,
    };
  }

  async deleteBucket(
    input: { readonly bucketName: string },
  ): Promise<boolean> {
    const result = await gcpJsonFetch(this.#tokens, {
      method: "DELETE",
      url: `https://storage.googleapis.com/storage/v1/b/${
        encodeURIComponent(input.bucketName)
      }`,
      fetch: this.#fetch,
    });
    if (result.status === 404) return false;
    ensureGcpResponseOk(result, `gcs:DeleteBucket ${input.bucketName}`);
    return true;
  }
}
