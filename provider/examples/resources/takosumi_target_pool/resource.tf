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

resource "takosumi_target_pool" "default" {
  name = "default"

  target = [{
    name           = "cloudflare-main"
    type           = "cloudflare"
    ref            = "cf-account-id"
    credential_ref = "conn_cloudflare_main"
    priority       = 80
  }, {
    name           = "containers-main"
    type           = "kubernetes"
    ref            = "cluster-prod"
    credential_ref = "conn_k8s_prod"
    priority       = 70

    implementation = [{
      shape                = "ContainerService"
      implementation       = "custom_container_runtime"
      native_resource_type = "custom.container_service"
      plugin               = "takosumi-container-plugin"
      options_json         = jsonencode({ runtimeClass = "edge" })

      interfaces = {
        oci_container = "native"
        public_http   = "shim"
      }
    }]
  }]
}

output "target_pool_id" {
  value = takosumi_target_pool.default.id
}
