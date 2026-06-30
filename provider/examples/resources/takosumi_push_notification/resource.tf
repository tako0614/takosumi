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

resource "takosumi_push_notification" "push" {
  name        = "push"
  protocols   = ["web_push", "fcm"]
  ttl_seconds = 3600
}

output "push_selected_implementation" {
  value = takosumi_push_notification.push.selected_implementation
}

output "push_outputs" {
  value = takosumi_push_notification.push.outputs
}
