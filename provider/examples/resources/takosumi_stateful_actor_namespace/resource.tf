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

# The Resource owns the namespace lifecycle. Actor instances (for example a
# room id) are addressed at runtime and are not separate Resource objects.
resource "takosumi_stateful_actor_namespace" "rooms" {
  name            = "rooms"
  class_name      = "RoomActor"
  storage_profile = "durable_sqlite"
  migration_tag   = "v1"
}

output "actor_namespace_outputs" {
  value = takosumi_stateful_actor_namespace.rooms.outputs
}
