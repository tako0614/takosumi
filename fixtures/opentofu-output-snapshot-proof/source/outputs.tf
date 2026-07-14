output "site_origin" {
  value = "https://demo.fixture.example"
}

output "management_origin" {
  value = "https://demo.fixture.example/admin"
}

output "health_probe" {
  value = "https://demo.fixture.example/health"
}

output "deployment_token" {
  value     = "fixture-secret"
  sensitive = true
}
