#!/bin/sh
set -eu

deployment_root=${DEPLOYMENT_ROOT:-/opt/agentern}
config=/etc/google-cloud-ops-agent/config.yaml

if ! command -v google_cloud_ops_agent_engine >/dev/null 2>&1 && ! systemctl list-unit-files google-cloud-ops-agent.service >/dev/null 2>&1; then
  echo "Google Cloud Ops Agent is not installed; skipping metrics configuration" >&2
  exit 0
fi

install -d -m 0755 /etc/google-cloud-ops-agent
cat > "$config" <<EOF
metrics:
  receivers:
    agentern:
      type: prometheus
      config:
        scrape_configs:
          - job_name: agentern
            scrape_interval: 60s
            metrics_path: /metrics
            authorization:
              type: Bearer
              credentials_file: $deployment_root/ops/secrets/metrics_token
            static_configs:
              - targets: ["127.0.0.1:3000"]
  service:
    pipelines:
      agentern:
        receivers: [agentern]
logging:
  receivers:
    agentern_docker:
      type: files
      include_paths: [/var/lib/docker/containers/*/*-json.log]
  service:
    pipelines:
      agentern:
        receivers: [agentern_docker]
EOF
chmod 0600 "$config"
systemctl restart google-cloud-ops-agent
