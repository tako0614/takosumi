variable "endpointName" {
  type        = string
  description = "Logical AI endpoint name."
}

variable "implementation" {
  type        = string
  description = "Resolver-selected implementation, such as cloudflare_ai_gateway or openai_compatible_ai_endpoint."
}

variable "targetName" {
  type        = string
  description = "Resolver-selected TargetPool entry name."
}

variable "targetType" {
  type        = string
  description = "Resolver-selected Target type."
}

variable "baseUrl" {
  type        = string
  description = "Public or internal base URL projected by the selected target/adapter. Empty means the adapter owns projection."
  default     = ""
}

variable "defaultModel" {
  type        = string
  description = "Optional public default model alias."
  default     = ""
}

variable "allowedModels" {
  type        = list(string)
  description = "Optional public model alias allow-list."
  default     = []
}

variable "interfaces" {
  type        = list(string)
  description = "Requested AI API interfaces, for example openai_chat_completions."
}

variable "profiles" {
  type        = list(string)
  description = "Requested compatibility profiles, for example openai_compatible."
  default     = []
}

locals {
  projected_base_url = var.baseUrl
}

output "base_url" {
  description = "OpenAI-compatible or profile-specific endpoint base URL when projected by the selected adapter."
  value       = local.projected_base_url
}

output "default_model" {
  description = "Default public model alias for this endpoint, if configured."
  value       = var.defaultModel
}
