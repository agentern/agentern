output "external_ip" {
  value = google_compute_address.agentern.address
}

output "instance_name" {
  value = google_compute_instance.agentern.name
}

output "zone" {
  value = var.zone
}

output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_service_account" {
  value = google_service_account.github_deploy.email
}

output "secret_ids" {
  value = { for name, secret in google_secret_manager_secret.agentern : name => secret.secret_id }
}
