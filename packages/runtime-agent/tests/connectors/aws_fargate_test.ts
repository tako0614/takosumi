import assert from "node:assert/strict";
import { AwsFargateConnector } from "../../src/connectors/aws/fargate.ts";
import { recordingFetch } from "./_fetch_mock.ts";

const credentials = {
  accessKeyId: "AKIA",
  secretAccessKey: "s",
};

Deno.test("AwsFargateConnector.apply registers task def and creates service", async () => {
  // The lifecycle calls RegisterTaskDefinition then CreateService — both 200.
  const responses = [
    new Response(
      JSON.stringify({
        taskDefinition: {
          taskDefinitionArn: "arn:aws:ecs:us-east-1::task-definition/x:1",
        },
      }),
      { status: 200 },
    ),
    new Response("{}", { status: 200 }),
  ];
  let callIdx = 0;
  const { fetch: mockFetch, calls } = recordingFetch(() =>
    responses[callIdx++]
  );
  const connector = new AwsFargateConnector({
    region: "us-east-1",
    credentials,
    clusterName: "takos",
    subnetIds: ["subnet-1"],
    fetch: mockFetch,
  });
  const res = await connector.apply({
    shape: "web-service@v1",
    provider: "aws-fargate",
    resourceName: "rs",
    spec: {
      image: "registry/app:1",
      port: 8080,
      scale: { min: 1, max: 3 },
      env: { FOO: "bar" },
    },
  });
  assert.equal(res.handle, "arn:aws:ecs:us-east-1:operator:service/takos/app");
  assert.equal(res.outputs.internalHost, "app.takos.local");
  assert.equal(res.outputs.internalPort, 8080);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].headers.get("x-amz-target"),
    "AmazonEC2ContainerServiceV20141113.RegisterTaskDefinition",
  );
  assert.equal(
    calls[1].headers.get("x-amz-target"),
    "AmazonEC2ContainerServiceV20141113.CreateService",
  );
});
