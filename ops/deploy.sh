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

docker compose config --quiet
mkdir -p var
chmod 0755 var

docker compose pull db migrate maintenance web

previous_release=""
if [ -s "$release_file" ]; then
  previous_release=$(cat "$release_file")
  COMPOSE_FILE="$compose_files" sh ops/backup.sh
fi

docker compose up -d --no-build db valkey

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

docker compose up -d --no-build --force-recreate web caddy

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
