import assert from "node:assert/strict";
import { AwsS3Connector } from "../../src/connectors/aws/s3.ts";
import { recordingFetch } from "./_fetch_mock.ts";

const credentials = {
  accessKeyId: "AKIA-test",
  secretAccessKey: "secret-test",
};

Deno.test("AwsS3Connector.apply creates bucket and returns ARN handle", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response("", { status: 200 })
  );
  const connector = new AwsS3Connector({
    region: "us-east-1",
    credentials,
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "object-store@v1",
    provider: "@takos/aws-s3",
    resourceName: "rs",
    spec: { name: "tenant-data" },
  }, {});
  assert.equal(res.handle, "arn:aws:s3:::tenant-data");
  assert.equal(res.outputs.bucket, "tenant-data");
  assert.equal(res.outputs.region, "us-east-1");
  // 1 call for CreateBucket, 1 call for PutPublicAccessBlock (default true)
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "PUT");
  assert.match(calls[0].url, /tenant-data\.s3\.amazonaws\.com/);
  assert.match(calls[1].url, /publicAccessBlock/);
});

Deno.test("AwsS3Connector.describe returns missing on 404", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response("", { status: 404 })
  );
  const connector = new AwsS3Connector({
    region: "us-east-1",
    credentials,
    fetch: mockFetch,
  });
  const res = await connector.describe({
    shape: "object-store@v1",
    provider: "@takos/aws-s3",
    handle: "arn:aws:s3:::missing",
  }, {});
  assert.equal(res.status, "missing");
});

Deno.test("AwsS3Connector.verify returns ok on 200 ListBuckets", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(
      "<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>",
      { status: 200 },
    )
  );
  const connector = new AwsS3Connector({
    region: "us-east-1",
    credentials,
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, true);
  assert.equal(res.note, "credentials valid");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /^https:\/\/s3\.us-east-1\.amazonaws\.com\/$/);
});

Deno.test("AwsS3Connector.verify reports auth_failed on 401", async () => {
  const { fetch: mockFetch } = recordingFetch(() =>
    new Response("<Error><Code>InvalidAccessKeyId</Code></Error>", {
      status: 401,
    })
  );
  const connector = new AwsS3Connector({
    region: "us-east-1",
    credentials,
    fetch: mockFetch,
  });
  const res = await connector.verify({});
  assert.equal(res.ok, false);
  assert.equal(res.code, "auth_failed");
  assert.match(`${res.note}`, /s3:ListBuckets/);
});

Deno.test("AwsS3Connector.destroy parses bucket from ARN", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response("", { status: 200 })
  );
  const connector = new AwsS3Connector({
    region: "us-east-1",
    credentials,
    fetch: mockFetch,
  });
  const res = await connector.destroy({
    shape: "object-store@v1",
    provider: "@takos/aws-s3",
    handle: "arn:aws:s3:::my-bucket",
  }, {});
  assert.equal(res.ok, true);
  assert.match(calls[0].url, /my-bucket\.s3\.amazonaws\.com/);
  assert.equal(calls[0].method, "DELETE");
});
