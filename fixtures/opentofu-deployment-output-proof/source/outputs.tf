output "takosumi_launch_url" {
  value = "https://demo.fixture.example"
}

output "takosumi_admin_url" {
  value = "https://demo.fixture.example/admin"
}

output "health_url" {
  value = "https://demo.fixture.example/health"
}

output "deployment_token" {
  value     = "fixture-secret"
  sensitive = true
}
