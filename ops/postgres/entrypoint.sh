#!/bin/sh
set -eu

read_secret() {
  name=$1
  file=$2
  if [ -n "$file" ]; then
    value=$(cat "$file")
    export "$name=$value"
  fi
}

read_secret PGBACKREST_REPO1_CIPHER_PASS "${PGBACKREST_REPO1_CIPHER_PASS_FILE:-}"

# The original deployment configuration used GCS's S3 compatibility API. Use
# its bucket setting as a temporary migration fallback for the native GCS API.
if [ -z "${PGBACKREST_REPO1_GCS_BUCKET:-}" ] && [ -n "${PGBACKREST_REPO1_S3_BUCKET:-}" ]; then
  export PGBACKREST_REPO1_GCS_BUCKET="$PGBACKREST_REPO1_S3_BUCKET"
fi

# The *_FILE names are a Compose convention, not pgBackRest options. Keep
# them out of PostgreSQL's inherited environment so archive_command does not
# emit invalid-option warnings on every WAL segment.
unset PGBACKREST_REPO1_CIPHER_PASS_FILE
unset PGBACKREST_REPO1_S3_BUCKET

exec docker-entrypoint.sh "$@"
