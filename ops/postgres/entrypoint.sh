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

read_secret PGBACKREST_REPO1_S3_KEY "${PGBACKREST_REPO1_S3_KEY_FILE:-}"
read_secret PGBACKREST_REPO1_S3_KEY_SECRET "${PGBACKREST_REPO1_S3_KEY_SECRET_FILE:-}"
read_secret PGBACKREST_REPO1_CIPHER_PASS "${PGBACKREST_REPO1_CIPHER_PASS_FILE:-}"

# The *_FILE names are a Compose convention, not pgBackRest options. Keep
# them out of PostgreSQL's inherited environment so archive_command does not
# emit invalid-option warnings on every WAL segment.
unset PGBACKREST_REPO1_S3_KEY_FILE
unset PGBACKREST_REPO1_S3_KEY_SECRET_FILE
unset PGBACKREST_REPO1_CIPHER_PASS_FILE

exec docker-entrypoint.sh "$@"
