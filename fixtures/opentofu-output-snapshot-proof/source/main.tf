terraform {
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

resource "local_file" "proof" {
  filename = "${path.module}/takosumi-provider-proof.txt"
  content  = "arbitrary-provider-path-ok"
}

output "provider_proof_path" {
  value = local_file.proof.filename
}
