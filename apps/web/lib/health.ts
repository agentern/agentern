import { getDatabase } from "@workspace/db"
import { sql } from "drizzle-orm"

import { assertProductionConfiguration } from "@/lib/config"
import { getRedis } from "@/lib/redis"

export async function readiness() {
  try {
    assertProductionConfiguration()
    await getDatabase().execute(sql`select 1`)
    await (await getRedis()).ping()
    return Response.json({ status: "ready" }, { headers: { "cache-control": "no-store" } })
  } catch {
    return Response.json({ status: "unready" }, { status: 503, headers: { "cache-control": "no-store" } })
  }
}
