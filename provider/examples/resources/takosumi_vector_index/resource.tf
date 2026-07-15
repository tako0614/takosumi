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

resource "takosumi_vector_index" "embeddings" {
  name       = "embeddings"
  dimensions = 1536
  metric     = "cosine"
}

output "vector_index_outputs" {
  value = takosumi_vector_index.embeddings.outputs
}
