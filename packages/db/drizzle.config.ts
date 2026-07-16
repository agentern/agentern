import { defineConfig } from "drizzle-kit"
import { readFileSync } from "node:fs"

const databaseUrl = process.env.DATABASE_URL?.trim() || (process.env.DATABASE_URL_FILE ? readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim() : undefined)

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl ?? "postgres://agentern:agentern@localhost:5432/agentern",
  },
})
