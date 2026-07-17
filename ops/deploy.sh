#!/bin/sh
set -eu

deployment_root=${DEPLOYMENT_ROOT:-/opt/agentern}
compose_files=${COMPOSE_FILE:-compose.yaml:compose.production.yaml:compose.secrets.yaml}
health_url=${DEPLOY_HEALTH_URL:-http://127.0.0.1:3000/readyz}
public_health_url=${DEPLOY_PUBLIC_HEALTH_URL:-https://agentern.com/readyz}
release_file="$deployment_root/.release"
previous_release_file="$deployment_root/.previous-release"

: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${IMAGE_REPOSITORY:?IMAGE_REPOSITORY is required}"

case "$RELEASE_SHA" in
  *[!0-9a-f]* | "")
    echo "RELEASE_SHA must be a lowercase hexadecimal commit SHA" >&2
    exit 2
    ;;
esac

case "$IMAGE_REPOSITORY" in
  ghcr.io/*/*) ;;
  *)
    echo "IMAGE_REPOSITORY must be a ghcr.io owner/repository path" >&2
    exit 2
    ;;
esac

export COMPOSE_FILE="$compose_files"
export WEB_IMAGE="$IMAGE_REPOSITORY:$RELEASE_SHA-web"
export MIGRATE_IMAGE="$IMAGE_REPOSITORY:$RELEASE_SHA-migrate"
export POSTGRES_IMAGE="$IMAGE_REPOSITORY:$RELEASE_SHA-postgres"

cd "$deployment_root"

if [ ! -f .env ]; then
  echo "$deployment_root/.env is missing; provision production configuration before deploying" >&2
  exit 2
fi

for secret in postgres_password database_url token_pepper metrics_token admin_cli_secret proxy_shared_secret pgbackrest_s3_key pgbackrest_s3_key_secret pgbackrest_cipher_pass; do
  secret_file="ops/secrets/$secret"
  if [ ! -s "$secret_file" ]; then
    echo "$deployment_root/$secret_file is missing or empty" >&2
    exit 2
  fi
done

sh ops/validate-production-config.sh .env ops/secrets
docker compose config --quiet
mkdir -p var
chmod 0755 var

docker compose pull db migrate maintenance web caddy

# Keep the public listener and TLS termination available even if a first boot
# later fails while preparing PostgreSQL, backups, or migrations. Caddy has no
# dependency on the application container and will proxy once web is healthy.
if ! docker compose up -d --no-build caddy; then
  echo "Caddy failed to start; deployment diagnostics:" >&2
  docker compose ps caddy >&2 || true
  docker compose logs --no-color --tail=200 caddy >&2 || true
  exit 1
fi

docker compose up -d --no-build db valkey

wait_for_db() {
  db_container=$(docker compose ps --all --quiet db)
  [ -n "$db_container" ] || return 1
  attempt=1
  while [ "$attempt" -le 60 ]; do
    db_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$db_container")
    case "$db_health" in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

if ! wait_for_db; then
  echo "Database failed readiness before backup or migrations:" >&2
  docker compose ps db valkey >&2 || true
  docker compose logs --no-color --tail=200 db valkey >&2 || true
  exit 1
fi

previous_release=""
if [ -s "$release_file" ]; then
  previous_release=$(cat "$release_file")
  COMPOSE_FILE="$compose_files" sh ops/backup.sh
fi

run_pgbackrest() {
  docker compose exec -T db sh -ceu '
    unset PGBACKREST_REPO1_S3_KEY_FILE PGBACKREST_REPO1_S3_KEY_SECRET_FILE PGBACKREST_REPO1_CIPHER_PASS_FILE
    export PGBACKREST_REPO1_S3_KEY="$(cat /run/secrets/pgbackrest_s3_key)"
    export PGBACKREST_REPO1_S3_KEY_SECRET="$(cat /run/secrets/pgbackrest_s3_key_secret)"
    export PGBACKREST_REPO1_CIPHER_PASS="$(cat /run/secrets/pgbackrest_cipher_pass)"
    exec pgbackrest --pg1-user="${POSTGRES_USER:-agentern}" "$@"
  ' -- "$@"
}

if ! run_pgbackrest --stanza=agentern stanza-create; then
  echo "pgBackRest stanza initialization failed:" >&2
  docker compose logs --no-color --tail=200 db >&2 || true
  exit 1
fi

# A previous stop/restore operation may have left pgBackRest's async
# archiver paused. `start` is idempotent and permits archive-push workers to
# run again before the readiness check generates a WAL segment.
if ! run_pgbackrest --stanza=agentern start; then
  echo "pgBackRest async archiver could not be started:" >&2
  docker compose logs --no-color --tail=200 db >&2 || true
  exit 1
fi

if ! docker compose up -d --no-build --force-recreate migrate; then
  echo "Migration dependency failed to start; database and cache diagnostics:" >&2
  docker compose ps db valkey >&2 || true
  docker compose logs --no-color --tail=200 db valkey >&2 || true
  exit 1
fi
migrate_container=$(docker compose ps --all --quiet migrate)
if [ -z "$migrate_container" ]; then
  echo "Migration container was not created" >&2
  exit 1
fi

while :; do
  migrate_status=$(docker inspect --format '{{.State.Status}}' "$migrate_container")
  case "$migrate_status" in
    exited)
      migrate_exit=$(docker inspect --format '{{.State.ExitCode}}' "$migrate_container")
      if [ "$migrate_exit" -ne 0 ]; then
        docker compose logs --no-color migrate >&2
        exit "$migrate_exit"
      fi
      break
      ;;
    dead | removing)
      docker compose logs --no-color migrate >&2
      exit 1
      ;;
  esac
  sleep 1
done

if ! docker compose up -d --no-build --force-recreate web caddy; then
  echo "Web/Caddy failed to start; deployment diagnostics:" >&2
  docker compose ps web caddy >&2 || true
  docker compose logs --no-color --tail=200 web caddy >&2 || true
  exit 1
fi

wait_for_health() {
  attempt=1
  while [ "$attempt" -le 60 ]; do
    if curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null &&
      curl --fail --silent --show-error --max-time 5 "$public_health_url" >/dev/null; then
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

if ! wait_for_health; then
  docker compose logs --no-color --tail=200 web caddy >&2
  if [ -n "$previous_release" ]; then
    echo "Release $RELEASE_SHA failed readiness; restoring web release $previous_release" >&2
    export WEB_IMAGE="$IMAGE_REPOSITORY:$previous_release-web"
    docker compose pull web
    docker compose up -d --no-build --force-recreate web caddy
    if ! wait_for_health; then
      echo "Automatic rollback to $previous_release also failed readiness" >&2
      docker compose logs --no-color --tail=200 web caddy >&2
    fi
  fi
  exit 1
fi

if [ -n "$previous_release" ]; then
  printf '%s\n' "$previous_release" > "$previous_release_file"
fi
printf '%s\n' "$RELEASE_SHA" > "$release_file"

deployment_env_tmp="$deployment_root/.deployment.env.tmp.$$"
umask 077
{
  printf 'WEB_IMAGE=%s\n' "$WEB_IMAGE"
  printf 'MIGRATE_IMAGE=%s\n' "$MIGRATE_IMAGE"
  printf 'POSTGRES_IMAGE=%s\n' "$POSTGRES_IMAGE"
} > "$deployment_env_tmp"
mv "$deployment_env_tmp" "$deployment_root/.deployment.env"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  for service in ops/systemd/*.service; do
    service_name=$(basename "$service")
    sed "s|@DEPLOYMENT_ROOT@|$deployment_root|g" "$service" > "/etc/systemd/system/$service_name"
    chmod 0644 "/etc/systemd/system/$service_name"
  done
  install -m 0644 ops/systemd/*.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now agentern-backup.timer agentern-retention.timer agentern-restore-verify.timer
  DEPLOYMENT_ROOT="$deployment_root" sh ops/configure-ops-agent.sh
fi

docker image prune --force --filter 'until=168h' >/dev/null
echo "Agentern release $RELEASE_SHA is ready"
