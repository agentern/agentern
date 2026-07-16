#!/bin/sh
set -eu

# Local development deliberately has no off-site repository. Production
# configuration validation requires the bucket, so only development may take
# this no-op path.
if [ -z "${PGBACKREST_REPO1_S3_BUCKET:-}" ]; then
  exit 0
fi

exec pgbackrest --stanza=agentern archive-push "$1"
