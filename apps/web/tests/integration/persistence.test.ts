import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { and, eq, inArray } from "drizzle-orm"
import { agents, comments, connections, getDatabase, moderationReports, platformSettings, posts, reactions } from "@workspace/db"

import { checkRateLimit, getRedis } from "@/lib/redis"

const run = Boolean(process.env.TEST_DATABASE_URL)
const handles = [`integration-${Date.now()}-a`, `integration-${Date.now()}-b`]

describe.skipIf(!run)("PostgreSQL social constraints", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  })

  afterAll(async () => {
    await getDatabase().delete(agents).where(inArray(agents.handle, handles))
  })

  it("enforces connection uniqueness, counters, reaction replacement, reports, and soft deletion", async () => {
    const db = getDatabase()
    const created = await db
      .insert(agents)
      .values(
        handles.map((handle) => ({ handle, displayName: handle, headline: "Integration agent", avatarSeed: handle })),
      )
      .returning()
    const [a, b] = created.sort((left, right) => left.id.localeCompare(right.id))
    const [post] = await db.insert(posts).values({ authorId: a!.id, body: "Integration post" }).returning()

    await db.insert(connections).values({ agentAId: a!.id, agentBId: b!.id, requesterId: a!.id })
    await expect(
      db.insert(connections).values({ agentAId: a!.id, agentBId: b!.id, requesterId: b!.id }),
    ).rejects.toThrow()

    await db.insert(reactions).values({ postId: post!.id, agentId: b!.id, kind: "like" })
    await db
      .insert(reactions)
      .values({ postId: post!.id, agentId: b!.id, kind: "insightful" })
      .onConflictDoUpdate({ target: [reactions.postId, reactions.agentId], set: { kind: "insightful" } })
    const reaction = await db.query.reactions.findFirst({
      where: and(eq(reactions.postId, post!.id), eq(reactions.agentId, b!.id)),
    })
    expect(reaction?.kind).toBe("insightful")
    expect((await db.query.posts.findFirst({ where: eq(posts.id, post!.id) }))?.reactionCount).toBe(1)

    const [comment] = await db.insert(comments).values({ postId: post!.id, authorId: b!.id, body: "Integration comment" }).returning()
    expect((await db.query.posts.findFirst({ where: eq(posts.id, post!.id) }))?.commentCount).toBe(1)
    await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, comment!.id))
    expect((await db.query.posts.findFirst({ where: eq(posts.id, post!.id) }))?.commentCount).toBe(0)

    await db.insert(moderationReports).values({ reporterId: b!.id, targetType: "post", targetId: post!.id, reason: "Integration report" })
    await expect(db.insert(moderationReports).values({ reporterId: b!.id, targetType: "post", targetId: post!.id, reason: "Duplicate report" })).rejects.toThrow()

    await db.update(platformSettings).set({ mutationsEnabled: false }).where(eq(platformSettings.id, 1))
    expect((await db.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1) }))?.mutationsEnabled).toBe(false)
    await db.update(platformSettings).set({ mutationsEnabled: true }).where(eq(platformSettings.id, 1))

    await db.update(posts).set({ deletedAt: new Date() }).where(eq(posts.id, post!.id))
    expect((await db.query.posts.findFirst({ where: eq(posts.id, post!.id) }))?.deletedAt).toBeInstanceOf(Date)
  })

  it("applies atomic Valkey limits under concurrency", async () => {
    if (!process.env.VALKEY_URL) return
    const key = `integration-${Date.now()}`
    const results = await Promise.all(Array.from({ length: 10 }, () => checkRateLimit(key, 3, 60)))
    expect(results.filter((result) => result.allowed)).toHaveLength(3)
    await (await getRedis()).del(`rate:${key}`)
  })
})
