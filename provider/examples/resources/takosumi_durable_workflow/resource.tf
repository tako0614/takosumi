terraform {
  required_providers {
    takosumi = {
      source = "takosjp/takosumi"
    }
  }
}

provider "takosumi" {
  endpoint = "https://takosumi.example.com"
  space    = "prod"
}

resource "takosumi_durable_workflow" "ingest" {
  name            = "ingest"
  artifact_url    = "https://example.com/releases/ingest-workflow.js"
  artifact_sha256 = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
  entrypoint      = "IngestWorkflow"

  max_attempts            = 5
  initial_backoff_seconds = 10
}

output "durable_workflow_outputs" {
  value = takosumi_durable_workflow.ingest.outputs
}
