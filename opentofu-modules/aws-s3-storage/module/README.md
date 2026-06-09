# aws-s3-storage (first-party Capsule module)

Creates a single AWS S3 bucket from `bucketName` + `region`.

- Provider: `hashicorp/aws`. Authentication is via environment variables /
  assume-role session minted by Takosumi at dispatch (`AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`); this module never embeds secrets.
- Inputs: `bucketName` (string, required), `region` (string, optional, default
  `us-east-1`).
- Outputs: `bucket_name`, `bucket_arn`, `region`.
- No build phase — the OpenTofu surface is the module alone.

This directory is baked into the runner image at
`/app/templates/aws-s3-storage/module`. Takosumi generates a root module that
wires this module via `source = "./template-module"` with the typed inputs.
