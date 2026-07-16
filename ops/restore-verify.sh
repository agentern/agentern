#!/bin/sh
set -eu

. "$(dirname "$0")/runtime-env.sh"

: "${POSTGRES_IMAGE:?POSTGRES_IMAGE is required for restore verification}"

started_at=$(date +%s)
suffix=$(date -u +%Y%m%d%H%M%S)
container="agentern-restore-verify-$suffix"
volume="agentern-restore-verify-$suffix"
metric_file=var/restore.prom
metric_tmp="$metric_file.tmp.$$"
restore_status=0
previous_success=0
if [ -f "$metric_file" ]; then
  previous_success=$(sed -n 's/^agentern_restore_verification_last_success_timestamp_seconds //p' "$metric_file" | head -n 1)
  previous_success=${previous_success:-0}
fi

cleanup() {
  docker container rm --force "$container" >/dev/null 2>&1 || true
  docker volume rm --force "$volume" >/dev/null 2>&1 || true
  finished_at=$(date +%s)
  success_timestamp=$previous_success
  if [ "$restore_status" -eq 1 ]; then success_timestamp=$finished_at; fi
  {
    echo "agentern_restore_verification_last_attempt_timestamp_seconds $finished_at"
    echo "agentern_restore_verification_last_success_timestamp_seconds $success_timestamp"
    echo "agentern_restore_verification_last_status $restore_status"
    echo "agentern_restore_verification_duration_seconds $((finished_at - started_at))"
  } > "$metric_tmp"
  chmod 0644 "$metric_tmp"
  mv "$metric_tmp" "$metric_file"
}
trap cleanup EXIT INT TERM

docker volume create "$volume" >/dev/null
docker run --rm \
  --user root \
  --env-file .env \
  --env PGBACKREST_REPO1_S3_KEY_FILE=/run/secrets/pgbackrest_s3_key \
  --env PGBACKREST_REPO1_S3_KEY_SECRET_FILE=/run/secrets/pgbackrest_s3_key_secret \
  --env PGBACKREST_REPO1_CIPHER_PASS_FILE=/run/secrets/pgbackrest_cipher_pass \
  --volume "$deployment_root/ops/secrets/pgbackrest_s3_key:/run/secrets/pgbackrest_s3_key:ro" \
  --volume "$deployment_root/ops/secrets/pgbackrest_s3_key_secret:/run/secrets/pgbackrest_s3_key_secret:ro" \
  --volume "$deployment_root/ops/secrets/pgbackrest_cipher_pass:/run/secrets/pgbackrest_cipher_pass:ro" \
  --volume "$volume:/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE" \
  sh -ceu 'chown -R postgres:postgres /var/lib/postgresql/data; exec su-exec postgres pgbackrest --stanza=agentern --pg1-path=/var/lib/postgresql/data restore'

docker run --detach \
  --name "$container" \
  --env-file .env \
  --env PGBACKREST_REPO1_S3_KEY_FILE=/run/secrets/pgbackrest_s3_key \
  --env PGBACKREST_REPO1_S3_KEY_SECRET_FILE=/run/secrets/pgbackrest_s3_key_secret \
  --env PGBACKREST_REPO1_CIPHER_PASS_FILE=/run/secrets/pgbackrest_cipher_pass \
  --volume "$deployment_root/ops/secrets/pgbackrest_s3_key:/run/secrets/pgbackrest_s3_key:ro" \
  --volume "$deployment_root/ops/secrets/pgbackrest_s3_key_secret:/run/secrets/pgbackrest_s3_key_secret:ro" \
  --volume "$deployment_root/ops/secrets/pgbackrest_cipher_pass:/run/secrets/pgbackrest_cipher_pass:ro" \
  --volume "$volume:/var/lib/postgresql/data" \
  "$POSTGRES_IMAGE" \
  postgres -c config_file=/etc/postgresql/postgresql.conf -c archive_mode=off -c listen_addresses= >/dev/null

attempt=1
while [ "$attempt" -le 120 ]; do
  if docker exec "$container" pg_isready -U "${POSTGRES_USER:-agentern}" -d "${POSTGRES_DB:-agentern}" >/dev/null 2>&1; then
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
    docker logs "$container" >&2
    exit 1
  fi
  sleep 2
  attempt=$((attempt + 1))
done

if [ "$attempt" -gt 120 ]; then
  docker logs "$container" >&2
  exit 1
fi

verification=$(docker exec "$container" psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-agentern}" -d "${POSTGRES_DB:-agentern}" -Atc \
  "select count(*) >= 0 from agents; select count(*) >= 0 from posts; select not pg_is_in_recovery();")
expected=$(printf 't\nt\nt')
if [ "$verification" != "$expected" ]; then
  echo "Restored database consistency checks failed" >&2
  exit 1
fi

restore_status=1
