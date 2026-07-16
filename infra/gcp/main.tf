data "google_project" "current" {}

locals {
  services = toset([
    "compute.googleapis.com",
    "dns.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
    "sts.googleapis.com",
  ])
  secret_names = toset([
    "env",
    "postgres-password",
    "database-url",
    "token-pepper",
    "metrics-token",
    "admin-cli-secret",
    "proxy-shared-secret",
    "pgbackrest-s3-key",
    "pgbackrest-s3-key-secret",
    "pgbackrest-cipher-pass",
  ])
  github_principal = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

resource "google_project_service" "required" {
  for_each           = local.services
  service            = each.value
  disable_on_destroy = false
}

resource "google_compute_network" "agentern" {
  name                    = "agentern"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.required["compute.googleapis.com"]]
}

resource "google_compute_subnetwork" "agentern" {
  name          = "agentern-${var.region}"
  network       = google_compute_network.agentern.id
  region        = var.region
  ip_cidr_range = "10.42.0.0/24"
}

resource "google_compute_address" "agentern" {
  name   = "agentern-production"
  region = var.region
}

resource "google_compute_firewall" "web" {
  name          = "agentern-public-web"
  network       = google_compute_network.agentern.name
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["agentern-web"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  allow {
    protocol = "udp"
    ports    = ["443"]
  }
}

resource "google_compute_firewall" "iap_ssh" {
  name          = "agentern-iap-ssh"
  network       = google_compute_network.agentern.name
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["agentern-iap-ssh"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_service_account" "runtime" {
  account_id   = "agentern-runtime"
  display_name = "Agentern VM runtime"
}

resource "google_service_account" "github_deploy" {
  account_id   = "agentern-github-deploy"
  display_name = "Agentern GitHub deployment"
}

resource "google_compute_instance" "agentern" {
  name         = var.instance_name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["agentern-web", "agentern-iap-ssh"]

  boot_disk {
    initialize_params {
      image = var.boot_image
      size  = var.boot_disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.agentern.id
    access_config {
      nat_ip = google_compute_address.agentern.address
    }
  }

  metadata = {
    block-project-ssh-keys = "TRUE"
    enable-oslogin         = "TRUE"
  }
  metadata_startup_script = templatefile("${path.module}/startup.sh.tftpl", {})

  service_account {
    email  = google_service_account.runtime.email
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "agentern-github"
  display_name              = "Agentern GitHub Actions"
  depends_on                = [google_project_service.required["iamcredentials.googleapis.com"]]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "agentern-repository"
  display_name                       = "Agentern repository"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.ref == 'refs/heads/main'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_federation" {
  service_account_id = google_service_account.github_deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.github_principal
}

resource "google_project_iam_member" "github_project_roles" {
  for_each = toset([
    "roles/compute.osAdminLogin",
    "roles/compute.viewer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_iap_tunnel_instance_iam_member" "github" {
  project  = var.project_id
  zone     = var.zone
  instance = google_compute_instance.agentern.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_service_account_iam_member" "runtime_user" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_secret_manager_secret" "agentern" {
  for_each  = local.secret_names
  secret_id = "${var.secret_prefix}-${each.value}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_iam_member" "github" {
  for_each  = google_secret_manager_secret.agentern
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_dns_record_set" "agentern" {
  count        = var.dns_managed_zone == "" ? 0 : 1
  managed_zone = var.dns_managed_zone
  name         = "${var.domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.agentern.address]
  depends_on   = [google_project_service.required["dns.googleapis.com"]]
}
