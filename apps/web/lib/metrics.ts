import { readFile } from "node:fs/promises"

import { getDatabase } from "@workspace/db"
import { sql } from "drizzle-orm"

const counters = new Map<string, number>()
const histogramBuckets = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10]
const durations = new Map<
  string,
  { name: string; label: string; count: number; sum: number; buckets: number[] }
>()
const operationsMetricFiles = ["backup.prom", "retention.prom", "restore.prom"]

function safeLabel(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 80)
}

function metricKey(name: string, label: string) {
  return `${safeLabel(name)}\u0000${safeLabel(label)}`
}

export function incrementMetric(name: string, label = "all") {
  const key = metricKey(name, label)
  counters.set(key, (counters.get(key) ?? 0) + 1)
}

export function observeDuration(name: string, label: string, seconds: number) {
  const safeName = safeLabel(name)
  const safeMetricLabel = safeLabel(label)
  const key = metricKey(safeName, safeMetricLabel)
  const current =
    durations.get(key) ??
    ({
      name: safeName,
      label: safeMetricLabel,
      count: 0,
      sum: 0,
      buckets: histogramBuckets.map(() => 0),
    } satisfies NonNullable<ReturnType<typeof durations.get>>)
  current.count += 1
  current.sum += seconds
  histogramBuckets.forEach((upperBound, index) => {
    if (seconds <= upperBound) current.buckets[index]! += 1
  })
  durations.set(key, current)
}

async function databaseMetrics() {
  try {
    const rows = await getDatabase().execute<{
      active_connections: number
      max_connections: number
      open_reports: number
      reports_last_day: number
    }>(sql`
      select
        (select count(*)::int from pg_stat_activity where datname = current_database()) as active_connections,
        current_setting('max_connections')::int as max_connections,
        (select count(*)::int from moderation_reports where status = 'open') as open_reports,
        (select count(*)::int from moderation_reports where created_at >= now() - interval '24 hours') as reports_last_day
    `)
    const row = rows[0]
    if (!row) throw new Error("Database metrics query returned no rows")
    return [
      "agentern_database_up 1",
      `agentern_database_connections ${row.active_connections}`,
      `agentern_database_max_connections ${row.max_connections}`,
      `agentern_moderation_open_reports ${row.open_reports}`,
      `agentern_moderation_reports_last_24_hours ${row.reports_last_day}`,
    ]
  } catch {
    return ["agentern_database_up 0"]
  }
}

async function operationsMetrics() {
  const directory = process.env.OPS_METRICS_DIR ?? "/run/agentern-ops"
  const lines: string[] = []
  const observed = new Set<string>()
  for (const file of operationsMetricFiles) {
    try {
      const contents = await readFile(`${directory}/${file}`, "utf8")
      for (const line of contents.split("\n")) {
        if (/^agentern_[a-z0-9_]+ (?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(line)) {
          lines.push(line)
          observed.add(line.slice(0, line.indexOf(" ")))
        }
      }
    } catch {
      // A missing file means that scheduled operation has not completed yet.
    }
  }
  for (const metric of [
    "agentern_backup_last_success_timestamp_seconds",
    "agentern_restore_verification_last_success_timestamp_seconds",
    "agentern_retention_last_success_timestamp_seconds",
  ]) {
    if (!observed.has(metric)) lines.push(`${metric} 0`)
  }
  return lines
}

export async function renderMetrics() {
  const lines = [
    "# HELP agentern_info Agentern process information",
    "# TYPE agentern_info gauge",
    "agentern_info 1",
  ]
  for (const [key, value] of counters) {
    const [name, label] = key.split("\u0000")
    lines.push(`agentern_${name}{label="${label}"} ${value}`)
  }
  for (const value of durations.values()) {
    histogramBuckets.forEach((upperBound, index) => {
      lines.push(
        `agentern_${value.name}_seconds_bucket{label="${value.label}",le="${upperBound}"} ${value.buckets[index]}`
      )
    })
    lines.push(
      `agentern_${value.name}_seconds_bucket{label="${value.label}",le="+Inf"} ${value.count}`
    )
    lines.push(
      `agentern_${value.name}_seconds_count{label="${value.label}"} ${value.count}`
    )
    lines.push(
      `agentern_${value.name}_seconds_sum{label="${value.label}"} ${value.sum.toFixed(6)}`
    )
  }
  lines.push(...(await databaseMetrics()), ...(await operationsMetrics()))
  return `${lines.join("\n")}\n`
}
