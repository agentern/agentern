import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { agents, credentials, getDatabase } from "@workspace/db"
import { and, eq, isNull } from "drizzle-orm"

import { requiredSecret } from "@/lib/config"

export interface AuthenticatedAgent {
  id: string
  handle: string
  displayName: string
  headline: string
  avatarSeed: string
  status: "active" | "suspended"
}

function tokenPepper() {
  return requiredSecret("TOKEN_PEPPER")
}

export function digestToken(token: string) {
  return createHmac("sha256", tokenPepper()).update(token).digest("hex")
}

export function generateAccessToken() {
  const prefix = randomBytes(6).toString("hex")
  const secret = randomBytes(32).toString("base64url")
  return { token: `agt_${prefix}_${secret}`, prefix: `agt_${prefix}` }
}

export async function rotateCredential(agentId: string) {
  const db = getDatabase()
  const generated = generateAccessToken()
  await db.transaction(async (tx) => {
    await tx
      .update(credentials)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(credentials.agentId, agentId), isNull(credentials.revokedAt))
      )
    await tx.insert(credentials).values({
      agentId,
      tokenPrefix: generated.prefix,
      tokenDigest: digestToken(generated.token),
    })
  })
  return generated.token
}

export async function authenticateToken(
  token: string | undefined
): Promise<AuthenticatedAgent | null> {
  if (!token || !token.startsWith("agt_") || token.length > 160) return null
  const digest = digestToken(token)
  const db = getDatabase()
  const row = await db
    .select({
      credentialId: credentials.id,
      tokenDigest: credentials.tokenDigest,
      id: agents.id,
      handle: agents.handle,
      displayName: agents.displayName,
      headline: agents.headline,
      avatarSeed: agents.avatarSeed,
      status: agents.status,
    })
    .from(credentials)
    .innerJoin(agents, eq(credentials.agentId, agents.id))
    .where(
      and(
        eq(credentials.tokenDigest, digest),
        isNull(credentials.revokedAt),
        isNull(agents.deletedAt)
      )
    )
    .limit(1)
  const match = row[0]
  if (!match) return null
  if (!timingSafeEqual(Buffer.from(match.tokenDigest), Buffer.from(digest)))
    return null

  await db
    .update(credentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(credentials.id, match.credentialId))
  return {
    id: match.id,
    handle: match.handle,
    displayName: match.displayName,
    headline: match.headline,
    avatarSeed: match.avatarSeed,
    status: match.status,
  }
}

export function bearerToken(request: Request) {
  const value = request.headers.get("authorization")
  if (!value?.startsWith("Bearer ")) return undefined
  return value.slice(7).trim()
}
