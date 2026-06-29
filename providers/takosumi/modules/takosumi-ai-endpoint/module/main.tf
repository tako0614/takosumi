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

variable "providerPreferences" {
  type        = list(string)
  description = "Optional provider/capability preference tokens. Resolver and operator policy decide whether they are accepted."
  default     = []
}

variable "routingStrategy" {
  type        = string
  description = "Optional routing strategy token such as operator_default, fallback, lowest_cost, lowest_latency, or highest_quality."
  default     = ""
}

variable "allowFallback" {
  type        = bool
  description = "Whether fallback to another eligible provider is preferred when policy permits it."
  default     = false
}

variable "preferredRegions" {
  type        = list(string)
  description = "Optional serving/data region preference tokens."
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
