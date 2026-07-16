import "server-only"

import { readFileSync } from "node:fs"

function value(name: string) {
  const direct = process.env[name]?.trim()
  if (direct) return direct
  const file = process.env[`${name}_FILE`]?.trim()
  if (!file) return undefined
  return readFileSync(file, "utf8").trim()
}

export function requiredSecret(
  name:
    | "TOKEN_PEPPER"
    | "ADMIN_CLI_SECRET"
    | "METRICS_BEARER_TOKEN"
    | "PROXY_SHARED_SECRET"
) {
  const secret = value(name)
  if (!secret) throw new Error(`${name} or ${name}_FILE is required`)
  const insecureDefaults = new Set([
    "local-development-pepper-change-before-production",
    "local-admin-secret-change-before-production",
    "local-metrics-secret-change-before-production",
    "local-proxy-secret-change-before-production",
  ])
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ENFORCE_PRODUCTION_CONFIG === "true" &&
    (secret.length < 32 || insecureDefaults.has(secret))
  ) {
    throw new Error(
      `${name} must be an independent production secret of at least 32 characters`
    )
  }
  return secret
}

export function publicOrigin() {
  const input =
    process.env.APP_BASE_URL ??
    (process.env.NODE_ENV === "production"
      ? undefined
      : "http://localhost:3000")
  if (!input) throw new Error("APP_BASE_URL is required")
  const url = new URL(input)
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ENFORCE_PRODUCTION_CONFIG === "true" &&
    url.protocol !== "https:"
  ) {
    throw new Error("APP_BASE_URL must use HTTPS in production")
  }
  return url.origin
}

export function assertProductionConfiguration() {
  if (
    process.env.NODE_ENV !== "production" ||
    process.env.ENFORCE_PRODUCTION_CONFIG !== "true"
  )
    return
  requiredSecret("TOKEN_PEPPER")
  requiredSecret("ADMIN_CLI_SECRET")
  requiredSecret("METRICS_BEARER_TOKEN")
  publicOrigin()
  requiredSecret("PROXY_SHARED_SECRET")
  const database = new URL(value("DATABASE_URL") ?? "")
  if (
    !database.password ||
    ["agentern", "change-me"].includes(database.password)
  )
    throw new Error("DATABASE_URL must use a strong production password")
  for (const name of [
    "LEGAL_ENTITY_NAME",
    "SUPPORT_EMAIL",
    "SECURITY_EMAIL",
  ] as const) {
    if (!process.env[name]?.trim())
      throw new Error(`${name} is required in production`)
  }
}

export function legalConfig() {
  return {
    entity: process.env.LEGAL_ENTITY_NAME?.trim() || "Agentern",
    supportEmail: process.env.SUPPORT_EMAIL?.trim() || "support@agentern.com",
    securityEmail:
      process.env.SECURITY_EMAIL?.trim() || "security@agentern.com",
  }
}
