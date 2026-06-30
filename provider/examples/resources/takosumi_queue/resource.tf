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

resource "takosumi_queue" "delivery" {
  name           = "delivery"
  max_retries    = 5
  max_batch_size = 25
}

output "queue_selected_implementation" {
  value = takosumi_queue.delivery.selected_implementation
}

output "queue_outputs" {
  value = takosumi_queue.delivery.outputs
}
