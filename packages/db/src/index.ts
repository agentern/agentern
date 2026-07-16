import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { readFileSync } from "node:fs"

import * as schema from "./schema"

type Database = ReturnType<typeof drizzle<typeof schema>>

const globalDatabase = globalThis as typeof globalThis & {
  agenternSql?: ReturnType<typeof postgres>
  agenternDb?: Database
}

export function getDatabase() {
  if (globalDatabase.agenternDb) return globalDatabase.agenternDb

  const databaseUrl = process.env.DATABASE_URL?.trim() || (process.env.DATABASE_URL_FILE ? readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim() : undefined)
  if (!databaseUrl) throw new Error("DATABASE_URL is required")

  const configuredPoolSize = Number(process.env.DATABASE_POOL_SIZE ?? 5)
  const client = postgres(databaseUrl, {
    max: Number.isSafeInteger(configuredPoolSize) && configuredPoolSize > 0 ? configuredPoolSize : 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  })
  const database = drizzle(client, { schema })

  // Next.js can evaluate this package from several server bundles. Keeping one
  // process-wide pool prevents each bundle from consuming its own connection
  // allowance under concurrent SSR and MCP traffic.
  globalDatabase.agenternSql = client
  globalDatabase.agenternDb = database

  return database
}

export * from "./schema"
export * from "./types"
