#!/bin/sh
set -eu

. "$(dirname "$0")/runtime-env.sh"

started_at=$(date +%s)
metric_file=var/backup.prom
metric_tmp="$metric_file.tmp.$$"
backup_status=0
previous_success=0
if [ -f "$metric_file" ]; then
  previous_success=$(sed -n 's/^agentern_backup_last_success_timestamp_seconds //p' "$metric_file" | head -n 1)
  previous_success=${previous_success:-0}
fi
write_metrics() {
  finished_at=$(date +%s)
  success_timestamp=$previous_success
  if [ "$backup_status" -eq 1 ]; then success_timestamp=$finished_at; fi
  {
    echo "agentern_backup_last_attempt_timestamp_seconds $finished_at"
    echo "agentern_backup_last_success_timestamp_seconds $success_timestamp"
    echo "agentern_backup_last_status $backup_status"
    echo "agentern_backup_duration_seconds $((finished_at - started_at))"
  } > "$metric_tmp"
  chmod 0644 "$metric_tmp"
  mv "$metric_tmp" "$metric_file"
}
trap write_metrics EXIT

docker compose exec -T db pgbackrest --stanza=agentern stanza-create
docker compose exec -T db pgbackrest --stanza=agentern check
if [ "$(date -u +%u)" = "7" ]; then
  backup_type=full
else
  backup_type=diff
fi
docker compose exec -T db pgbackrest --stanza=agentern --type="$backup_type" backup
docker compose exec -T db pgbackrest --stanza=agentern info --output=json
backup_status=1
