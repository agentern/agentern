#!/bin/sh
set -eu

env_file=${1:-.env}
if [ "${2:-}" = --env-only ]; then
  secret_dir=ops/secrets
  mode=--env-only
else
  secret_dir=${2:-ops/secrets}
  mode=${3:-}
fi

fail() {
  echo "Production configuration error: $*" >&2
  exit 2
}

[ -s "$env_file" ] || fail "$env_file is missing or empty"

config_value() {
  key=$1
  value=$(awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$env_file" |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  printf '%s' "$value"
}

# Read only the configuration keys we validate. Do not source the file: legal
# entity names and other values may contain spaces, and a Secret Manager value
# must never be executed as shell code.
APP_BASE_URL=$(config_value APP_BASE_URL)
AGENTERN_DOMAIN=$(config_value AGENTERN_DOMAIN)
ACME_EMAIL=$(config_value ACME_EMAIL)
LEGAL_ENTITY_NAME=$(config_value LEGAL_ENTITY_NAME)
SUPPORT_EMAIL=$(config_value SUPPORT_EMAIL)
SECURITY_EMAIL=$(config_value SECURITY_EMAIL)
PGBACKREST_REPO1_S3_BUCKET=$(config_value PGBACKREST_REPO1_S3_BUCKET)
PGBACKREST_REPO1_S3_ENDPOINT=$(config_value PGBACKREST_REPO1_S3_ENDPOINT)
PGBACKREST_REPO1_S3_REGION=$(config_value PGBACKREST_REPO1_S3_REGION)
POSTGRES_DB=$(config_value POSTGRES_DB)
POSTGRES_USER=$(config_value POSTGRES_USER)
ENFORCE_PRODUCTION_CONFIG=$(config_value ENFORCE_PRODUCTION_CONFIG)
TRUST_PROXY=$(config_value TRUST_PROXY)

require_value() {
  name=$1
  value=$2
  [ -n "$value" ] || fail "$name is required"
}

reject_placeholder() {
  name=$1
  value=$2
  case "$value" in
    *s3.example.com*|*.example.invalid*|*replace-with-*|*your-*|*change-me*|*change_before_production*|*localhost*|127.0.0.1|0.0.0.0)
      fail "$name contains a placeholder or local-only value"
      ;;
  esac
}

require_value APP_BASE_URL "${APP_BASE_URL:-}"
require_value AGENTERN_DOMAIN "${AGENTERN_DOMAIN:-}"
require_value ACME_EMAIL "${ACME_EMAIL:-}"
require_value LEGAL_ENTITY_NAME "${LEGAL_ENTITY_NAME:-}"
require_value SUPPORT_EMAIL "${SUPPORT_EMAIL:-}"
require_value SECURITY_EMAIL "${SECURITY_EMAIL:-}"
require_value PGBACKREST_REPO1_S3_BUCKET "${PGBACKREST_REPO1_S3_BUCKET:-}"
require_value PGBACKREST_REPO1_S3_ENDPOINT "${PGBACKREST_REPO1_S3_ENDPOINT:-}"
require_value PGBACKREST_REPO1_S3_REGION "${PGBACKREST_REPO1_S3_REGION:-}"
require_value POSTGRES_DB "${POSTGRES_DB:-}"
require_value POSTGRES_USER "${POSTGRES_USER:-}"

[ "${ENFORCE_PRODUCTION_CONFIG:-}" = true ] || fail "ENFORCE_PRODUCTION_CONFIG must be true"
[ "${TRUST_PROXY:-}" = true ] || fail "TRUST_PROXY must be true"
[ "$APP_BASE_URL" = "https://$AGENTERN_DOMAIN" ] ||
  fail "APP_BASE_URL must exactly match https://AGENTERN_DOMAIN"

case "$AGENTERN_DOMAIN" in
  *[!A-Za-z0-9.-]* | *.*.* | "") fail "AGENTERN_DOMAIN is invalid" ;;
esac
case "$PGBACKREST_REPO1_S3_ENDPOINT" in
  *://* | */* | "") fail "PGBACKREST_REPO1_S3_ENDPOINT must be a hostname" ;;
esac
case "$ACME_EMAIL" in
  *@*.*) ;;
  *) fail "ACME_EMAIL must be a real email address" ;;
esac
for email in "$SUPPORT_EMAIL" "$SECURITY_EMAIL"; do
  case "$email" in
    *@*.*) ;;
    *) fail "support and security contacts must be real email addresses" ;;
  esac
done

for pair in \
  "APP_BASE_URL=$APP_BASE_URL" \
  "AGENTERN_DOMAIN=$AGENTERN_DOMAIN" \
  "ACME_EMAIL=$ACME_EMAIL" \
  "LEGAL_ENTITY_NAME=$LEGAL_ENTITY_NAME" \
  "SUPPORT_EMAIL=$SUPPORT_EMAIL" \
  "SECURITY_EMAIL=$SECURITY_EMAIL" \
  "PGBACKREST_REPO1_S3_BUCKET=$PGBACKREST_REPO1_S3_BUCKET" \
  "PGBACKREST_REPO1_S3_ENDPOINT=$PGBACKREST_REPO1_S3_ENDPOINT" \
  "PGBACKREST_REPO1_S3_REGION=$PGBACKREST_REPO1_S3_REGION"; do
  name=${pair%%=*}
  value=${pair#*=}
  reject_placeholder "$name" "$value"
done

if [ "$mode" != --env-only ]; then
  [ -d "$secret_dir" ] || fail "$secret_dir is missing"
  for secret in postgres_password database_url token_pepper metrics_token admin_cli_secret proxy_shared_secret pgbackrest_s3_key pgbackrest_s3_key_secret pgbackrest_cipher_pass; do
    file="$secret_dir/$secret"
    [ -s "$file" ] || fail "$file is missing or empty"
    value=$(tr -d '\r\n' < "$file")
    reject_placeholder "$secret" "$value"
    case "$secret" in
      postgres_password|token_pepper|metrics_token|admin_cli_secret|proxy_shared_secret|pgbackrest_cipher_pass)
        [ "${#value}" -ge 32 ] || fail "$secret must contain at least 32 characters"
        ;;
      database_url)
        case "$value" in postgres://*|postgresql://*) ;; *) fail "database_url must be a PostgreSQL URL" ;; esac
        ;;
    esac
  done
fi

echo "Production configuration is valid"
