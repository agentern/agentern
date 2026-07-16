#!/bin/sh
set -eu

# Compose file secrets are bind-mounted with their host permissions. Read them
# while the container is still root, then drop privileges before starting the
# Next.js server so production secret files can remain root-readable only.
read_secret() {
  name=$1
  file=$2
  if [ -n "$file" ]; then
    [ -r "$file" ] || {
      echo "Unable to read secret file $file" >&2
      exit 1
    }
    value=$(cat "$file")
    [ -n "$value" ] || {
      echo "Secret file $file is empty" >&2
      exit 1
    }
    export "$name=$value"
  fi
}

read_secret DATABASE_URL "${DATABASE_URL_FILE:-}"
read_secret TOKEN_PEPPER "${TOKEN_PEPPER_FILE:-}"
read_secret METRICS_BEARER_TOKEN "${METRICS_BEARER_TOKEN_FILE:-}"
read_secret ADMIN_CLI_SECRET "${ADMIN_CLI_SECRET_FILE:-}"
read_secret PROXY_SHARED_SECRET "${PROXY_SHARED_SECRET_FILE:-}"
unset DATABASE_URL_FILE TOKEN_PEPPER_FILE METRICS_BEARER_TOKEN_FILE ADMIN_CLI_SECRET_FILE PROXY_SHARED_SECRET_FILE

exec su-exec nextjs:nodejs "$@"
