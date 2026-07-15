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

resource "takosumi_schedule" "nightly_ingest" {
  name     = "nightly-ingest"
  cron     = "0 0 * * *"
  timezone = "UTC"

  connections = [{
    name        = "workflow"
    resource    = "DurableWorkflow/ingest"
    permissions = ["invoke"]
    projection  = "schedule_trigger"
  }]
}

output "schedule_outputs" {
  value = takosumi_schedule.nightly_ingest.outputs
}
