import assert from "node:assert/strict";
import { AwsRdsConnector } from "../../src/connectors/aws/rds.ts";
import { recordingFetch } from "./_fetch_mock.ts";

const credentials = { accessKeyId: "AKIA", secretAccessKey: "s" };

const CREATE_RESPONSE = `<?xml version="1.0"?>
<CreateDBInstanceResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/">
  <CreateDBInstanceResult>
    <DBInstance>
      <DBInstanceIdentifier>pg-app-abc123</DBInstanceIdentifier>
      <DBName>app</DBName>
      <MasterUsername>app</MasterUsername>
      <EngineVersion>16</EngineVersion>
      <Endpoint>
        <Address>pg-app-abc123.us-east-1.rds.amazonaws.com</Address>
        <Port>5432</Port>
      </Endpoint>
      <DBInstanceArn>arn:aws:rds:us-east-1::db:pg-app-abc123</DBInstanceArn>
    </DBInstance>
  </CreateDBInstanceResult>
</CreateDBInstanceResponse>`;

Deno.test("AwsRdsConnector.apply parses RDS Query API XML and returns connection string", async () => {
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    new Response(CREATE_RESPONSE, {
      status: 200,
      headers: { "content-type": "text/xml" },
    })
  );
  const connector = new AwsRdsConnector({
    region: "us-east-1",
    credentials,
    passwordGenerator: () => "fixed-password",
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "database-postgres@v1",
    provider: "aws-rds",
    resourceName: "rs",
    spec: {
      version: "16",
      size: "small",
      storage: { sizeGiB: 20 },
      highAvailability: false,
    },
  });
  assert.match(res.handle, /^arn:aws:rds:us-east-1::db:pg-app-/);
  assert.equal(
    res.outputs.host,
    "pg-app-abc123.us-east-1.rds.amazonaws.com",
  );
  assert.equal(res.outputs.port, 5432);
  assert.equal(res.outputs.database, "app");
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /rds\.us-east-1\.amazonaws\.com/);
});
