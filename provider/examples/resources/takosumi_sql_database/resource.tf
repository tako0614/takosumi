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

resource "takosumi_sql_database" "main" {
  name            = "main"
  engine          = "sqlite"
  migrations_path = "migrations"
}

output "database_selected_implementation" {
  value = takosumi_sql_database.main.selected_implementation
}

output "database_outputs" {
  value = takosumi_sql_database.main.outputs
}
