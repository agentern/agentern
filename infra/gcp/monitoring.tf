locals {
  notification_channels = concat(
    var.alert_notification_channel_ids,
    google_monitoring_notification_channel.webhook[*].name,
  )
}

resource "google_monitoring_notification_channel" "webhook" {
  count        = var.alert_webhook_url == "" ? 0 : 1
  display_name = "Agentern operations webhook"
  type         = "webhook_tokenauth"
  labels = {
    url = var.alert_webhook_url
  }
  sensitive_labels {
    auth_token = var.alert_webhook_token
  }
  depends_on = [google_project_service.required["monitoring.googleapis.com"]]
}

resource "google_monitoring_uptime_check_config" "readyz" {
  display_name = "Agentern public readiness"
  timeout      = "10s"
  period       = "60s"

  http_check {
    path           = "/readyz"
    port           = 443
    request_method = "GET"
    use_ssl        = true
    validate_ssl   = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      host       = var.domain
      project_id = var.project_id
    }
  }

  depends_on = [google_project_service.required["monitoring.googleapis.com"]]
}

resource "google_monitoring_alert_policy" "readiness" {
  display_name          = "Agentern readiness failed three times"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Public readiness unavailable"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.readyz.uptime_check_id}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "180s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_NEXT_OLDER"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "mcp_error_rate" {
  display_name          = "Agentern MCP error rate above five percent"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Five-minute MCP error ratio"
    condition_prometheus_query_language {
      duration                  = "300s"
      evaluation_interval       = "60s"
      disable_metric_validation = true
      query                     = <<-EOT
        sum(rate(agentern_mcp_tool_total{label=~".*:error"}[5m]))
        /
        clamp_min(sum(rate(agentern_mcp_tool_total[5m])), 0.000001)
        > 0.05
      EOT
    }
  }
}

resource "google_monitoring_alert_policy" "mcp_latency" {
  display_name          = "Agentern MCP p95 latency above one second"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Five-minute MCP p95"
    condition_prometheus_query_language {
      duration                  = "300s"
      evaluation_interval       = "60s"
      disable_metric_validation = true
      query                     = "histogram_quantile(0.95, sum by (le) (rate(agentern_mcp_tool_seconds_bucket[5m]))) > 1"
    }
  }
}

resource "google_monitoring_alert_policy" "database_pool" {
  display_name          = "Agentern database connections above eighty percent"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Database connection pressure"
    condition_prometheus_query_language {
      duration                  = "300s"
      evaluation_interval       = "60s"
      disable_metric_validation = true
      query                     = "agentern_database_connections / agentern_database_max_connections > 0.8"
    }
  }
}

resource "google_monitoring_alert_policy" "backup_freshness" {
  display_name          = "Agentern backup is stale"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "No successful backup in thirty hours"
    condition_prometheus_query_language {
      duration                  = "300s"
      evaluation_interval       = "60s"
      disable_metric_validation = true
      query                     = "time() - agentern_backup_last_success_timestamp_seconds > 108000"
    }
  }
}

resource "google_monitoring_alert_policy" "restore_freshness" {
  display_name          = "Agentern restore verification is stale"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "No successful restore verification in thirty-five days"
    condition_prometheus_query_language {
      duration                  = "300s"
      evaluation_interval       = "60s"
      disable_metric_validation = true
      query                     = "time() - agentern_restore_verification_last_success_timestamp_seconds > 3024000"
    }
  }
}

resource "google_monitoring_alert_policy" "report_volume" {
  display_name          = "Agentern moderation report volume increased"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Reports received in twenty-four hours"
    condition_prometheus_query_language {
      duration                  = "300s"
      evaluation_interval       = "60s"
      disable_metric_validation = true
      query                     = "agentern_moderation_reports_last_24_hours > ${var.daily_report_alert_threshold}"
    }
  }
}

resource "google_monitoring_alert_policy" "link_preview_failures" {
  display_name          = "Agentern link preview failures above twenty percent"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Five-minute link preview failure ratio"
    condition_prometheus_query_language {
      duration                  = "300s"
      evaluation_interval       = "60s"
      disable_metric_validation = true
      query                     = <<-EOT
        sum(rate(agentern_link_preview_total{label="failure"}[5m]))
        /
        clamp_min(sum(rate(agentern_link_preview_total[5m])), 0.000001)
        > 0.2
      EOT
    }
  }
}

resource "google_monitoring_alert_policy" "disk" {
  display_name          = "Agentern disk usage above eighty percent"
  combiner              = "OR"
  notification_channels = local.notification_channels

  conditions {
    display_name = "Boot disk pressure"
    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"agent.googleapis.com/disk/percent_used\" AND resource.label.instance_id=\"${google_compute_instance.agentern.instance_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 80
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
}
