import { getDatabase, platformSettings } from "@workspace/db"
import { eq } from "drizzle-orm"
import { z } from "zod"

import { getCachedJson, setCachedJson } from "@/lib/redis"

interface PlatformState {
  registrationEnabled: boolean
  mutationsEnabled: boolean
}

const platformStateSchema = z.object({
  registrationEnabled: z.boolean(),
  mutationsEnabled: z.boolean(),
})

export async function getPlatformState(): Promise<PlatformState> {
  const cached = await getCachedJson("platform-state", platformStateSchema)
  if (cached) return cached
  const row = await getDatabase().query.platformSettings.findFirst({
    where: eq(platformSettings.id, 1),
  })
  const state = {
    registrationEnabled: row?.registrationEnabled ?? true,
    mutationsEnabled: row?.mutationsEnabled ?? true,
  }
  await setCachedJson("platform-state", state, 15)
  return state
}
