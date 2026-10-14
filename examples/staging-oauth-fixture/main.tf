# STAGING TEST FIXTURE ONLY (branch test/staging-oauth-fixture; never merge).
# Providerless module that requests a Capsule-bound Takosumi Accounts OIDC
# public client so the real OAuth authorization-code path can be exercised.
terraform {
  required_version = ">= 1.6.0"
}

variable "public_url" {
  type        = string
  description = "Reviewed public HTTPS origin used to derive the OIDC redirect URI."
}

variable "takosumi_accounts_url" {
  type = string
}

variable "takosumi_accounts_issuer_url" {
  type = string
}

variable "takosumi_accounts_client_id" {
  type = string
}

variable "takosumi_accounts_redirect_uri" {
  type = string
}

output "oidc_client_id" {
  value = var.takosumi_accounts_client_id
}

output "oidc_redirect_uri" {
  value = var.takosumi_accounts_redirect_uri
}

output "oidc_issuer_url" {
  value = var.takosumi_accounts_issuer_url
}
