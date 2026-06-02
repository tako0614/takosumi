output "oidc_issuer_url" {
  value = "https://accounts.fixture.example"
}

output "oidc_client_id" {
  value = "fixture-client"
}

output "oidc_client_secret" {
  value     = "fixture-secret"
  sensitive = true
}

output "assets_bucket" {
  value = "fixture-assets"
}

output "assets_endpoint" {
  value = "https://r2.fixture.example"
}
