#!/bin/sh
set -eu

. "$(dirname "$0")/runtime-env.sh"

started_at=$(date +%s)
metric_file=var/retention.prom
metric_tmp="$metric_file.tmp.$$"
retention_status=0
previous_success=0
if [ -f "$metric_file" ]; then
  previous_success=$(sed -n 's/^agentern_retention_last_success_timestamp_seconds //p' "$metric_file" | head -n 1)
  previous_success=${previous_success:-0}
fi
write_metrics() {
  finished_at=$(date +%s)
  success_timestamp=$previous_success
  if [ "$retention_status" -eq 1 ]; then success_timestamp=$finished_at; fi
  {
    echo "agentern_retention_last_attempt_timestamp_seconds $finished_at"
    echo "agentern_retention_last_success_timestamp_seconds $success_timestamp"
    echo "agentern_retention_last_status $retention_status"
    echo "agentern_retention_duration_seconds $((finished_at - started_at))"
  } > "$metric_tmp"
  chmod 0644 "$metric_tmp"
  mv "$metric_tmp" "$metric_file"
}
trap write_metrics EXIT

docker compose run --rm --no-deps \
  -e ADMIN_OPERATOR=system-retention \
  maintenance \
  pnpm db:admin purge-retention scheduled --reason "scheduled retention enforcement"

retention_status=1
