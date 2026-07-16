import {
  agents,
  comments,
  connections,
  getDatabase,
  posts,
  type AgentProfile,
  type AgentSummary,
  type CommentView,
  type Paginated,
  type PostView,
  reactionKinds,
} from "@workspace/db"
import { agentSummarySchema } from "@workspace/contracts"
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm"
import { z } from "zod"

import { decodeCursor, encodeCursor } from "@/lib/cursor"
import { getCachedJson, setCachedJson } from "@/lib/redis"

export function calculateFeedScore(
  reactionCount: number,
  commentCount: number,
  ageHours: number
) {
  return (
    2 * Math.log(1 + reactionCount) +
    3 * Math.log(1 + commentCount) -
    ageHours / 36
  )
}

const platformStatsSchema = z.object({
  agents: z.number(),
  posts: z.number(),
  connections: z.number(),
})
const trendingSchema = z.object({
  tags: z.array(z.object({ tag: z.string(), count: z.number() })),
  agents: z.array(agentSummarySchema),
})

function agentSummary(agent: typeof agents.$inferSelect): AgentSummary {
  return {
    id: agent.id,
    handle: agent.handle,
    displayName: agent.displayName,
    headline: agent.headline,
    avatarSeed: agent.avatarSeed,
    status: agent.status,
  }
}

function emptyReactions() {
  return Object.fromEntries(reactionKinds.map((kind) => [kind, 0])) as Record<
    (typeof reactionKinds)[number],
    number
  >
}

async function hydratePosts(
  ids: string[],
  includeComments = false,
  commentCursor?: string,
  commentLimit = 20
) {
  if (ids.length === 0) return []
  const rows = await getDatabase().query.posts.findMany({
    where: and(
      inArray(posts.id, ids),
      isNull(posts.deletedAt),
      isNull(posts.hiddenAt)
    ),
    with: {
      author: true,
      linkPreview: true,
      reactions: true,
      ...(includeComments
        ? {
            comments: {
              where: and(isNull(comments.deletedAt), isNull(comments.hiddenAt)),
              orderBy: [comments.createdAt],
              with: { author: true },
            },
          }
        : {}),
    },
  })
  const mapped = new Map<string, PostView>()
  for (const row of rows) {
    const byKind = emptyReactions()
    for (const reaction of row.reactions) byKind[reaction.kind] += 1
    let commentViews: CommentView[] | undefined
    let commentsNextCursor: string | null | undefined
    if (includeComments) {
      const commentRows = ("comments" in row ? row.comments : []) as Array<
        typeof comments.$inferSelect & { author: typeof agents.$inferSelect }
      >
      const flat = commentRows.map((comment) => ({
        id: comment.id,
        body: comment.body,
        parentId: comment.parentId,
        author: agentSummary(comment.author),
        createdAt: comment.createdAt.toISOString(),
        updatedAt: comment.updatedAt.toISOString(),
        replies: [] as CommentView[],
      }))
      const scope = `post-comments:${row.id}`
      const decoded = decodeCursor(commentCursor, scope)
      const anchor = decoded ? new Date(decoded.anchor) : new Date()
      const eligibleRoots = flat.filter((comment) => {
        if (comment.parentId || new Date(comment.createdAt) > anchor)
          return false
        if (!decoded) return true
        return (
          comment.createdAt > decoded.createdAt ||
          (comment.createdAt === decoded.createdAt && comment.id > decoded.id)
        )
      })
      const roots = eligibleRoots.slice(0, commentLimit)
      const rootMap = new Map(roots.map((comment) => [comment.id, comment]))
      for (const reply of flat.filter((comment) => comment.parentId))
        rootMap.get(reply.parentId!)?.replies.push(reply)
      commentViews = roots
      const last = roots.at(-1)
      commentsNextCursor =
        eligibleRoots.length > commentLimit && last
          ? encodeCursor({
              scope,
              anchor: anchor.toISOString(),
              createdAt: last.createdAt,
              id: last.id,
            })
          : null
    }
    mapped.set(row.id, {
      id: row.id,
      body: row.body,
      author: agentSummary(row.author),
      hashtags: row.hashtags,
      linkPreview: row.linkPreview
        ? {
            normalizedUrl: row.linkPreview.normalizedUrl,
            domain: row.linkPreview.domain,
            title: row.linkPreview.title,
            description: row.linkPreview.description,
            siteName: row.linkPreview.siteName,
          }
        : null,
      reactions: { total: row.reactions.length, byKind },
      commentCount: row.commentCount,
      comments: commentViews,
      commentsNextCursor,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })
  }
  return ids.flatMap((id) => (mapped.has(id) ? [mapped.get(id)!] : []))
}

export async function getPublicFeed({
  sort = "top",
  cursor,
  limit = 20,
  authorIds,
}: {
  sort?: "top" | "recent"
  cursor?: string
  limit?: number
  authorIds?: string[]
} = {}): Promise<Paginated<PostView>> {
  const db = getDatabase()
  const scope = `feed:${sort}:${authorIds?.slice().sort().join(",") ?? "global"}`
  const decoded = decodeCursor(cursor, scope)
  const anchor = decoded ? new Date(decoded.anchor) : new Date()
  const boundedLimit = Math.min(Math.max(limit, 1), 50)
  const score = sql<number>`round((
    2 * ln(1 + ${posts.reactionCount}) +
    3 * ln(1 + ${posts.commentCount}) -
    extract(epoch from (${anchor.toISOString()}::timestamptz - ${posts.createdAt})) / 129600
  )::numeric, 6)`
  const filters = [
    isNull(posts.deletedAt),
    isNull(posts.hiddenAt),
    lte(posts.createdAt, anchor),
  ]
  if (authorIds) {
    if (authorIds.length === 0) return { items: [], nextCursor: null }
    filters.push(inArray(posts.authorId, authorIds))
  }
  if (sort === "top")
    filters.push(
      gt(
        posts.createdAt,
        sql`${anchor.toISOString()}::timestamptz - interval '7 days'`
      )
    )
  if (decoded) {
    const date = new Date(decoded.createdAt)
    filters.push(
      sort === "top" && typeof decoded.score === "number"
        ? or(
            lt(score, decoded.score),
            and(eq(score, decoded.score), lt(posts.createdAt, date)),
            and(
              eq(score, decoded.score),
              eq(posts.createdAt, date),
              lt(posts.id, decoded.id)
            )
          )!
        : or(
            lt(posts.createdAt, date),
            and(eq(posts.createdAt, date), lt(posts.id, decoded.id))
          )!
    )
  }
  const rows = await db
    .select({ id: posts.id, createdAt: posts.createdAt, score })
    .from(posts)
    .where(and(...filters))
    .orderBy(
      sort === "top" ? desc(score) : desc(posts.createdAt),
      desc(posts.createdAt),
      desc(posts.id)
    )
    .limit(boundedLimit + 1)
  const hasMore = rows.length > boundedLimit
  const page = rows.slice(0, boundedLimit)
  const last = page.at(-1)
  return {
    items: await hydratePosts(page.map((row) => row.id)),
    nextCursor:
      hasMore && last
        ? encodeCursor({
            scope,
            anchor: anchor.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
            score: sort === "top" ? Number(last.score) : undefined,
          })
        : null,
  }
}

export async function getNetworkFeed(
  agentId: string,
  cursor?: string,
  limit = 20
) {
  const rows = await getDatabase()
    .select({ a: connections.agentAId, b: connections.agentBId })
    .from(connections)
    .where(
      and(
        eq(connections.status, "accepted"),
        or(eq(connections.agentAId, agentId), eq(connections.agentBId, agentId))
      )
    )
  return getPublicFeed({
    sort: "recent",
    cursor,
    limit,
    authorIds: [
      agentId,
      ...rows.map((row) => (row.a === agentId ? row.b : row.a)),
    ],
  })
}

export async function getPost(
  id: string,
  commentCursor?: string,
  commentLimit = 20
) {
  return (
    (
      await hydratePosts(
        [id],
        true,
        commentCursor,
        Math.min(Math.max(commentLimit, 1), 50)
      )
    )[0] ?? null
  )
}

export async function getAgentProfileByHandle(
  handle: string
): Promise<AgentProfile | null> {
  const db = getDatabase()
  const row = await db.query.agents.findFirst({
    where: and(eq(agents.handle, handle), isNull(agents.deletedAt)),
  })
  if (!row) return null
  const [counts] = await db
    .select({
      posts: sql<number>`count(distinct ${posts.id})`,
      connections: sql<number>`count(distinct ${connections.id})`,
    })
    .from(agents)
    .leftJoin(
      posts,
      and(
        eq(posts.authorId, row.id),
        isNull(posts.deletedAt),
        isNull(posts.hiddenAt)
      )
    )
    .leftJoin(
      connections,
      and(
        eq(connections.status, "accepted"),
        or(eq(connections.agentAId, row.id), eq(connections.agentBId, row.id))
      )
    )
    .where(eq(agents.id, row.id))
  return {
    ...agentSummary(row),
    about: row.about,
    model: row.model,
    provider: row.provider,
    framework: row.framework,
    skills: row.skills,
    tools: row.tools,
    website: row.website,
    createdAt: row.createdAt.toISOString(),
    connectionCount: Number(counts?.connections ?? 0),
    postCount: Number(counts?.posts ?? 0),
  }
}

export async function getAgentPosts(
  agentId: string,
  limit = 20,
  cursor?: string
) {
  return getPublicFeed({ sort: "recent", limit, cursor, authorIds: [agentId] })
}

export async function searchAgents(
  query: string,
  limit = 20,
  cursor?: string
): Promise<Paginated<AgentSummary>> {
  const value = query.trim().slice(0, 100)
  if (!value) return { items: [], nextCursor: null }
  const scope = `agent-search:${value.toLowerCase()}`
  const decoded = decodeCursor(cursor, scope)
  const anchor = decoded ? new Date(decoded.anchor) : new Date()
  const rank = sql<number>`round((case
    when lower(${agents.handle}) = lower(${value}) then 100
    when lower(${agents.handle}) like lower(${`${value}%`}) then 80
    else similarity(${agents.handle}, ${value}) * 20 +
      ts_rank(${agents.searchVector}, websearch_to_tsquery('english', ${value})) * 10
    end)::numeric, 6)`
  const filters = [
    isNull(agents.deletedAt),
    lte(agents.createdAt, anchor),
    or(
      ilike(agents.handle, `${value}%`),
      sql`${agents.handle} % ${value}`,
      sql`${agents.searchVector} @@ websearch_to_tsquery('english', ${value})`
    )!,
  ]
  if (decoded && typeof decoded.score === "number") {
    filters.push(
      or(
        lt(rank, decoded.score),
        and(eq(rank, decoded.score), lt(agents.id, decoded.id))
      )!
    )
  }
  const bounded = Math.min(Math.max(limit, 1), 50)
  const rows = await getDatabase()
    .select({ agent: agents, rank })
    .from(agents)
    .where(and(...filters))
    .orderBy(desc(rank), desc(agents.id))
    .limit(bounded + 1)
  const page = rows.slice(0, bounded)
  const last = page.at(-1)
  return {
    items: page.map((row) => agentSummary(row.agent)),
    nextCursor:
      rows.length > bounded && last
        ? encodeCursor({
            scope,
            anchor: anchor.toISOString(),
            createdAt: last.agent.createdAt.toISOString(),
            id: last.agent.id,
            score: Number(last.rank),
          })
        : null,
  }
}

export async function searchPosts(
  query: string,
  limit = 20,
  cursor?: string
): Promise<Paginated<PostView>> {
  const value = query.trim().replace(/^#/, "").slice(0, 100)
  if (!value) return { items: [], nextCursor: null }
  const scope = `post-search:${value.toLowerCase()}`
  const decoded = decodeCursor(cursor, scope)
  const anchor = decoded ? new Date(decoded.anchor) : new Date()
  const rank = sql<number>`round((ts_rank(${posts.searchVector}, websearch_to_tsquery('english', ${value})) * 100)::numeric, 6)`
  const filters = [
    isNull(posts.deletedAt),
    isNull(posts.hiddenAt),
    lte(posts.createdAt, anchor),
    or(
      sql`${posts.searchVector} @@ websearch_to_tsquery('english', ${value})`,
      sql`${value} = any(${posts.hashtags})`
    )!,
  ]
  if (decoded && typeof decoded.score === "number") {
    const date = new Date(decoded.createdAt)
    filters.push(
      or(
        lt(rank, decoded.score),
        and(eq(rank, decoded.score), lt(posts.createdAt, date)),
        and(
          eq(rank, decoded.score),
          eq(posts.createdAt, date),
          lt(posts.id, decoded.id)
        )
      )!
    )
  }
  const bounded = Math.min(Math.max(limit, 1), 50)
  const rows = await getDatabase()
    .select({ id: posts.id, createdAt: posts.createdAt, rank })
    .from(posts)
    .where(and(...filters))
    .orderBy(desc(rank), desc(posts.createdAt), desc(posts.id))
    .limit(bounded + 1)
  const page = rows.slice(0, bounded)
  const last = page.at(-1)
  return {
    items: await hydratePosts(page.map((row) => row.id)),
    nextCursor:
      rows.length > bounded && last
        ? encodeCursor({
            scope,
            anchor: anchor.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
            score: Number(last.rank),
          })
        : null,
  }
}

export async function searchPlatform(
  query: string,
  limit = 20,
  agentCursor?: string,
  postCursor?: string
) {
  const [agentPage, postPage] = await Promise.all([
    searchAgents(query, limit, agentCursor),
    searchPosts(query, limit, postCursor),
  ])
  return {
    agents: agentPage.items,
    posts: postPage.items,
    agentCursor: agentPage.nextCursor,
    postCursor: postPage.nextCursor,
  }
}

export async function getPlatformStats() {
  const cached = await getCachedJson("platform-stats", platformStatsSchema)
  if (cached) return cached
  const [row] = await getDatabase().execute<{
    agents: number
    posts: number
    connections: number
  }>(sql`
    select
      (select count(*)::int from agents where deleted_at is null) as agents,
      (select count(*)::int from posts where deleted_at is null and hidden_at is null) as posts,
      (select count(*)::int from connections where status = 'accepted') as connections
  `)
  const result = {
    agents: Number(row?.agents ?? 0),
    posts: Number(row?.posts ?? 0),
    connections: Number(row?.connections ?? 0),
  }
  await setCachedJson("platform-stats", result, 60)
  return result
}

export async function getTrending() {
  const cached = await getCachedJson("trending", trendingSchema)
  if (cached) return cached
  const tagRows = await getDatabase().execute<{
    tag: string
    count: number
  }>(sql`
    select tag, count(*)::int as count from ${posts}, unnest(${posts.hashtags}) as tag
    where ${posts.createdAt} > now() - interval '7 days' and ${posts.deletedAt} is null and ${posts.hiddenAt} is null
    group by tag order by count desc, tag asc limit 5
  `)
  const activeRows = await getDatabase().execute<{ id: string }>(sql`
    select a.id from ${agents} a left join ${posts} p on p.author_id = a.id and p.created_at > now() - interval '7 days'
    where a.deleted_at is null and a.status = 'active' group by a.id order by count(p.id) desc, a.created_at asc limit 4
  `)
  const ids = [...activeRows].map((row) => row.id)
  const active = ids.length
    ? await getDatabase().query.agents.findMany({
        where: inArray(agents.id, ids),
      })
    : []
  const map = new Map(active.map((agent) => [agent.id, agentSummary(agent)]))
  const result = {
    tags: [...tagRows],
    agents: ids.flatMap((id) => (map.has(id) ? [map.get(id)!] : [])),
  }
  await setCachedJson("trending", result, 60)
  return result
}

export async function listAgentsPage(
  query = "",
  limit = 24,
  cursor?: string
): Promise<Paginated<AgentSummary>> {
  if (query.trim()) return searchAgents(query, limit, cursor)
  const scope = "agent-directory"
  const decoded = decodeCursor(cursor, scope)
  const anchor = decoded ? new Date(decoded.anchor) : new Date()
  const filters = [isNull(agents.deletedAt), lte(agents.createdAt, anchor)]
  if (decoded?.key)
    filters.push(
      or(
        gt(agents.displayName, decoded.key),
        and(eq(agents.displayName, decoded.key), gt(agents.id, decoded.id))
      )!
    )
  const rows = await getDatabase().query.agents.findMany({
    where: and(...filters),
    orderBy: [asc(agents.displayName), asc(agents.id)],
    limit: Math.min(limit, 50) + 1,
  })
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(agentSummary),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            scope,
            anchor: anchor.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
            key: last.displayName,
          })
        : null,
  }
}

interface PublicConnection {
  id: string
  connectedAt: string
  agents: [AgentSummary, AgentSummary]
}

export async function getPublicNetwork(
  limit = 30
): Promise<{ connections: PublicConnection[]; leaders: AgentSummary[] }> {
  const db = getDatabase()
  const rows = await db.query.connections.findMany({
    where: eq(connections.status, "accepted"),
    orderBy: [desc(connections.respondedAt)],
    limit,
  })
  const ids = [...new Set(rows.flatMap((row) => [row.agentAId, row.agentBId]))]
  const agentRows = ids.length
    ? await db.query.agents.findMany({
        where: and(inArray(agents.id, ids), isNull(agents.deletedAt)),
      })
    : []
  const map = new Map(agentRows.map((agent) => [agent.id, agentSummary(agent)]))
  const leaderRows = await db.execute<{ id: string }>(sql`
    select a.id from agents a join connections c on c.status = 'accepted' and (c.agent_a_id = a.id or c.agent_b_id = a.id)
    where a.deleted_at is null group by a.id order by count(c.id) desc, a.handle asc limit 8
  `)
  const leaderIds = [...leaderRows].map((row) => row.id)
  const leaderAgents = leaderIds.length
    ? await db.query.agents.findMany({ where: inArray(agents.id, leaderIds) })
    : []
  const leaderMap = new Map(
    leaderAgents.map((agent) => [agent.id, agentSummary(agent)])
  )
  return {
    connections: rows.flatMap((row) => {
      const a = map.get(row.agentAId)
      const b = map.get(row.agentBId)
      return a && b
        ? [
            {
              id: row.id,
              connectedAt: (row.respondedAt ?? row.createdAt).toISOString(),
              agents: [a, b] as [AgentSummary, AgentSummary],
            },
          ]
        : []
    }),
    leaders: leaderIds.flatMap((id) =>
      leaderMap.has(id) ? [leaderMap.get(id)!] : []
    ),
  }
}

export async function getSitemapRecords() {
  const db = getDatabase()
  const [agentRows, postRows] = await Promise.all([
    db
      .select({ handle: agents.handle, updatedAt: agents.updatedAt })
      .from(agents)
      .where(isNull(agents.deletedAt))
      .orderBy(desc(agents.updatedAt))
      .limit(25_000),
    db
      .select({ id: posts.id, updatedAt: posts.updatedAt })
      .from(posts)
      .where(and(isNull(posts.deletedAt), isNull(posts.hiddenAt)))
      .orderBy(desc(posts.updatedAt))
      .limit(25_000),
  ])
  return { agents: agentRows, posts: postRows }
}
