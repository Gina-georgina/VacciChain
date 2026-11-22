terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {
    bucket = "vaccichain-tfstate"
    key    = "staging/terraform.tfstate"
    region = "us-east-1"
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region"      { type = string; default = "us-east-1" }
variable "backend_image"   { type = string }
variable "frontend_image"  { type = string }
variable "analytics_image" { type = string }

# Persistence strategy for the event index (backlog #52).
# Staging mirrors production topology: a single ALB fronts the backend, so the
# SQLite-based index is retained here for load/failure analysis. The selected
# multi-writer database option is exercised via the persistence_mode variable.
variable "persistence_mode" {
  type        = string
  default     = "sqlite"
  description = "Event index persistence backend: 'sqlite' (single-writer) or 'postgres' (multi-writer)."
  validation {
    condition     = contains(["sqlite", "postgres"], var.persistence_mode)
    error_message = "persistence_mode must be either 'sqlite' or 'postgres'."
  }
}

# Trust-proxy configuration (backlog #56).
# Staging sits behind exactly one ALB hop, so the backend must trust the
# forwarded headers from that single proxy layer only. This prevents spoofed
# X-Forwarded-For headers from bypassing rate limits or corrupting audit
# attribution.
variable "trust_proxy_hops" {
  type        = number
  default     = 1
  description = "Number of trusted proxy hops in front of the backend (matches ALB topology)."
}

locals {
  env = "staging"

  # Derived trust-proxy setting passed to the backend container. A numeric hop
  # count is used rather than a blanket `true` so only the ALB is trusted.
  trust_proxy_setting = tostring(var.trust_proxy_hops)

  backend_environment = {
    PERSISTENCE_MODE = var.persistence_mode
    TRUST_PROXY      = local.trust_proxy_setting
  }
}

module "vpc" {
  source   = "../../modules/vpc"
  name     = "vaccichain-${local.env}"
  cidr     = "10.1.0.0/16"
  az_count = 2
}

module "secrets" {
  source = "../../modules/secrets"
  name   = "vaccichain-${local.env}"
}

module "ecs" {
  source          = "../../modules/ecs"
  name            = "vaccichain-${local.env}"
  vpc_id          = module.vpc.vpc_id
  public_subnets  = module.vpc.public_subnets
  private_subnets = module.vpc.private_subnets
  backend_image   = var.backend_image
  frontend_image  = var.frontend_image
  analytics_image = var.analytics_image
  secret_arns     = module.secrets.secret_arns
  desired_count   = 1

  # Persistence and trust-proxy configuration for the staging topology.
  backend_environment = local.backend_environment
  trust_proxy_hops    = var.trust_proxy_hops
}

output "alb_dns_name" { value = module.ecs.alb_dns_name }

output "persistence_mode" { value = var.persistence_mode }

output "trust_proxy_hops" { value = var.trust_proxy_hops }