terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

variable "bucketName" {
  type        = string
  description = "Globally-unique S3 bucket name to create."
}

variable "region" {
  type        = string
  description = "AWS region for the bucket."
  default     = "us-east-1"
}

# Provider credentials (and region) are minted by Takosumi at dispatch via the
# AWS environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION or an
# assume-role session); no inline secrets here.
provider "aws" {
  region = var.region
}

resource "aws_s3_bucket" "this" {
  bucket = var.bucketName
}

output "bucket_name" {
  description = "Name of the created S3 bucket."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "ARN of the created S3 bucket."
  value       = aws_s3_bucket.this.arn
}

output "region" {
  description = "Region the bucket was created in."
  value       = var.region
}
