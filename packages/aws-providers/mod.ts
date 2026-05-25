/**
 * `@takos/takosumi-aws-providers` — AWS-backed `KernelPlugin` factories
 * for operator-opt-in takosumi.com reference kind URIs.
 *
 * Phase D extracted these factories out of `@takos/takosumi-plugins` reference registry
 * so Takosumi core no longer carries cloud-coupled imports. Operators that
 * want AWS provider coverage explicitly import this package and pass the
 * factory results into `createPaaSApp({ kindAliases, plugins: [...] })`.
 *
 * Exports:
 *   - `awsFargateWebServiceProvider`    → `web-service@v1` (AWS Fargate)
 *   - `awsS3ObjectStoreProvider`        → `object-store@v1` (AWS S3)
 *   - `awsRdsPostgresProvider`          → `postgres@v1` (AWS RDS)
 *   - `awsRoute53CustomDomainProvider`  → `gateway@v1` (AWS Route53)
 */

export {
  awsFargateWebServiceProvider,
  type AwsFargateWebServiceProviderOptions,
  awsFargateWorkerProvider,
  type AwsFargateWorkerProviderOptions,
} from "./src/worker-aws-fargate.ts";
export {
  awsS3ObjectStoreProvider,
  type AwsS3ProviderOptions,
} from "./src/object-store-aws-s3.ts";
export {
  awsRdsPostgresProvider,
  type AwsRdsPostgresProviderOptions,
} from "./src/postgres-aws-rds.ts";
export {
  awsRoute53CustomDomainProvider,
  type AwsRoute53ProviderOptions,
} from "./src/custom-domain-aws-route53.ts";
