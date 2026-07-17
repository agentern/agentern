# Automatic deployment to Google Compute Engine

Agentern deploys after every successful `main` build. GitHub Actions publishes `linux/amd64` and `linux/arm64` images, exchanges its GitHub OIDC identity for a short-lived Google credential, opens an SSH connection through IAP using OS Login, synchronizes runtime configuration from Secret Manager, and runs the deployment script. No SSH private key or persistent registry credential is stored in GitHub.

## Provision the infrastructure

The Terraform module in `infra/gcp` creates:

- A dedicated VPC and firewall rules exposing only HTTP/HTTPS publicly and SSH through the IAP range.
- A static address and optional Cloud DNS record.
- An Ubuntu VM, defaulting to a two-vCPU/eight-GB Arm64 N4A machine with a 100 GB Hyperdisk Balanced boot disk.
- OS Login, dedicated runtime/deployment service accounts, GitHub Workload Identity Federation restricted to this repository's `main` branch, and per-instance IAP access.
- Secret Manager containers, the Google Ops Agent, an uptime check, and readiness, latency, error-rate, database-pressure, backup-freshness, and disk alerts.

Create a private Terraform variable file and use an encrypted remote Terraform backend:

```hcl
project_id        = "your-gcp-project"
github_repository = "your-github-owner/agentern"
region            = "us-central1"
zone              = "us-central1-a"

# Optional if agentern.com is hosted in Cloud DNS.
dns_managed_zone = "agentern-com"

# Supply at least one real notification destination before launch.
alert_notification_channel_ids = [
  "projects/your-gcp-project/notificationChannels/123456789",
]
```

```sh
cd infra/gcp
terraform init
terraform plan -out=agentern.tfplan
terraform apply agentern.tfplan
```

The defaults create an Arm64 N4A VM. N4A requires Hyperdisk and does not support Persistent Disk or Local SSD. For x86, select an e2/n2 machine, set `boot_image` to the Ubuntu amd64 image family, and set `boot_disk_type = "pd-balanced"` if desired. If an existing VM must be retained, import it and the infrastructure it uses into Terraform before applying; never apply a plan that proposes replacing a production disk.

## Provision Secret Manager once

Copy `.env.production.example` to an ignored `.env.production`, fill in the legal/contact and pgBackRest endpoint values, then run the idempotent provisioning helper. It generates independent credentials without writing them to disk and will not rotate an existing enabled version:

```sh
export GCP_PROJECT_ID=your-gcp-project
export PGBACKREST_S3_KEY='your-independent-object-store-key'
export PGBACKREST_S3_KEY_SECRET='your-independent-object-store-secret'
sh infra/gcp/provision-secrets.sh .env.production
```

The off-site object-storage credentials remain externally supplied because backup storage must be independent from the VM. Re-running the helper validates the environment file and refreshes only the `agentern-env` version when its contents change; existing credential versions are left untouched. Rotation is performed separately by adding coordinated credential versions and deploying again. Do not put production values in `.env.production.example`, Terraform variables, Git, or GitHub secrets.

## Configure the GitHub production environment

Create a GitHub environment named `production`, restrict it to `main`, and add these non-secret environment variables from `terraform output`:

| Variable                         | Value                                 |
| -------------------------------- | ------------------------------------- |
| `GCP_PROJECT_ID`                 | GCP project ID                        |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `workload_identity_provider` output   |
| `GCP_DEPLOY_SERVICE_ACCOUNT`     | `deploy_service_account` output       |
| `GCP_INSTANCE_NAME`              | `instance_name` output                |
| `GCP_ZONE`                       | Optional explicit zone; when omitted, CI resolves the zone of `GCP_INSTANCE_NAME` |
| `GCP_SECRET_PREFIX`              | `agentern` unless changed             |
| `GCP_DEPLOY_PATH`                | Optional; defaults to `/opt/agentern` |

No `GCP_VPS_SSH_PRIVATE_KEY`, host-key, username, or public SSH port is needed. GitHub's job requires only `id-token: write`; Google validates the repository and branch claims before issuing a short-lived credential.

## Deployment behavior

A push to `main` runs lint, type checking, migrations, unit/integration/MCP/E2E tests, Lighthouse, dependency scans, container scans, and secret scans. Release images are built on native amd64 and arm64 GitHub-hosted runners (rather than QEMU emulation) and then combined into one multi-architecture tag. Only when all jobs pass does CI:

1. Publish commit-addressed `SHA-web`, `SHA-migrate`, and `SHA-postgres` multi-architecture images.
2. Authenticate to GCP with Workload Identity Federation.
3. Synchronize `.env` and Docker secret files directly from Secret Manager over IAP SSH.
4. Start Caddy and its public HTTP/HTTPS listeners before database preparation, then pull immutable images and back up an existing database.
5. Apply migrations before replacing web; Caddy remains available while preparation failures are diagnosed.
6. Require local and public HTTPS readiness.
7. Restore the previous web image if readiness fails.
8. Install and enable daily backup, daily retention, and monthly isolated restore-verification timers.
9. Configure the Google Ops Agent to scrape authenticated application/operations metrics and rotated Docker JSON logs.

The current and previous release SHAs are stored in `/opt/agentern/.release` and `/opt/agentern/.previous-release`. The generated `.deployment.env` stores only immutable image references.

## Release tags

Pushing a `v*` tag no longer rebuilds code. The release workflow verifies that all three tested SHA manifests exist and promotes them to `vX.Y.Z-web`, `vX.Y.Z-migrate`, and `vX.Y.Z-postgres`. Tag only a commit whose `main` deployment completed successfully.

## Verification

```sh
gcloud compute ssh agentern-production \
  --project your-gcp-project \
  --zone us-central1-a \
  --tunnel-through-iap

sudo systemctl list-timers 'agentern-*'
sudo journalctl -u agentern-backup.service -u agentern-retention.service -u agentern-restore-verify.service
curl --fail https://agentern.com/readyz
```

Before launch, confirm all alert policies have a working notification channel and perform one observed full restore. Automated restore verification supplements—but does not replace—the incident recovery drill.
