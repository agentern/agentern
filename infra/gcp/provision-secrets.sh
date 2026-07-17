#!/bin/sh
set -eu

: "${GCP_PROJECT_ID:?GCP_PROJECT_ID is required}"
: "${PGBACKREST_S3_KEY:?PGBACKREST_S3_KEY is required}"
: "${PGBACKREST_S3_KEY_SECRET:?PGBACKREST_S3_KEY_SECRET is required}"

prefix=${GCP_SECRET_PREFIX:-agentern}
env_file=${1:-.env.production}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

sh "$script_dir/../../ops/validate-production-config.sh" "$env_file" --env-only

if [ ! -s "$env_file" ]; then
  echo "$env_file is missing or empty" >&2
  exit 2
fi

has_version() {
  [ -n "$(gcloud secrets versions list "$1" --project "$GCP_PROJECT_ID" --filter='state=ENABLED' --limit=1 --format='value(name)')" ]
}

add_value() {
  secret=$1
  value=$2
  if has_version "$secret"; then
    echo "$secret already has an enabled version; leaving it unchanged"
    return
  fi
  printf '%s' "$value" | gcloud secrets versions add "$secret" --project "$GCP_PROJECT_ID" --data-file=- >/dev/null
  echo "Provisioned $secret"
}

add_file() {
  secret=$1
  file=$2
  if has_version "$secret"; then
    echo "$secret already has an enabled version; leaving it unchanged"
    return
  fi
  gcloud secrets versions add "$secret" --project "$GCP_PROJECT_ID" --data-file="$file" >/dev/null
  echo "Provisioned $secret"
}

refresh_file() {
  secret=$1
  file=$2
  if ! has_version "$secret"; then
    add_file "$secret" "$file"
    return
  fi

  local_digest=$(sha256sum "$file" | awk '{print $1}')
  remote_digest=$(gcloud secrets versions access latest --project "$GCP_PROJECT_ID" --secret "$secret" | sha256sum | awk '{print $1}')
  if [ "$local_digest" = "$remote_digest" ]; then
    echo "$secret is unchanged; leaving it unchanged"
    return
  fi
  gcloud secrets versions add "$secret" --project "$GCP_PROJECT_ID" --data-file="$file" >/dev/null
  echo "Refreshed $secret"
}

postgres_secret="$prefix-postgres-password"
database_url_secret="$prefix-database-url"
if has_version "$postgres_secret" || has_version "$database_url_secret"; then
  if ! has_version "$postgres_secret" || ! has_version "$database_url_secret"; then
    echo "$postgres_secret and $database_url_secret must either both exist or both be absent" >&2
    exit 2
  fi
else
  postgres_password=$(openssl rand -hex 32)
  add_value "$postgres_secret" "$postgres_password"
  add_value "$database_url_secret" "postgres://agentern:$postgres_password@db:5432/agentern"
fi

refresh_file "$prefix-env" "$env_file"
add_value "$prefix-token-pepper" "$(openssl rand -hex 32)"
add_value "$prefix-metrics-token" "$(openssl rand -hex 32)"
add_value "$prefix-admin-cli-secret" "$(openssl rand -hex 32)"
add_value "$prefix-proxy-shared-secret" "$(openssl rand -hex 32)"
add_value "$prefix-pgbackrest-s3-key" "$PGBACKREST_S3_KEY"
add_value "$prefix-pgbackrest-s3-key-secret" "$PGBACKREST_S3_KEY_SECRET"
add_value "$prefix-pgbackrest-cipher-pass" "$(openssl rand -hex 32)"
