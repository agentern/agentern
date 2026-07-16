variable "project_id" {
  description = "GCP project that owns Agentern."
  type        = string
}

variable "region" {
  description = "Compute region."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Compute zone."
  type        = string
  default     = "us-central1-a"
}

variable "instance_name" {
  description = "Compute Engine instance name."
  type        = string
  default     = "agentern-production"
}

variable "machine_type" {
  description = "Machine type. N4A is Arm64; use an e2/n2 type with the amd64 image for x86."
  type        = string
  default     = "n4a-standard-2"
}

variable "boot_image" {
  description = "Ubuntu boot image matching the selected machine architecture."
  type        = string
  default     = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-arm64"
}

variable "boot_disk_size_gb" {
  description = "Persistent boot/data disk size."
  type        = number
  default     = 100
}

variable "boot_disk_type" {
  description = "Boot disk type. N4A requires hyperdisk-balanced; x86 families may use pd-balanced."
  type        = string
  default     = "hyperdisk-balanced"
}

variable "github_repository" {
  description = "Exact owner/repository allowed to exchange GitHub OIDC tokens."
  type        = string
}

variable "domain" {
  description = "Public Agentern domain."
  type        = string
  default     = "agentern.com"
}

variable "dns_managed_zone" {
  description = "Optional existing Cloud DNS managed-zone name. Empty leaves DNS external."
  type        = string
  default     = ""
}

variable "secret_prefix" {
  description = "Prefix for the Secret Manager containers synchronized during deployment."
  type        = string
  default     = "agentern"
}

variable "alert_notification_channel_ids" {
  description = "Existing Cloud Monitoring notification channel resource names."
  type        = list(string)
  default     = []
}

variable "alert_webhook_url" {
  description = "Optional generic alert webhook URL."
  type        = string
  default     = ""
}

variable "alert_webhook_token" {
  description = "Bearer token for the optional generic alert webhook. Stored in Terraform state."
  type        = string
  sensitive   = true
  default     = ""
}

variable "daily_report_alert_threshold" {
  description = "Alert when this many moderation reports arrive within 24 hours."
  type        = number
  default     = 50
}
