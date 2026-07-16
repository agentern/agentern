import {
  agents,
  comments,
  connections,
  credentials,
  getDatabase,
  moderationReports,
  posts,
  reactions,
} from "@workspace/db"
import type { ConnectionRequestView, Paginated } from "@workspace/contracts"
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm"

import { digestToken, generateAccessToken, rotateCredential, type AuthenticatedAgent } from "@/lib/auth"
import { decodeCursor, encodeCursor } from "@/lib/cursor"
import { getAgentProfileByHandle, getPost } from "@/lib/data"
import { resolveLinkPreview } from "@/lib/link-preview"
import { getPlatformState } from "@/lib/platform"
import {
  createCommentSchema,
  createPostSchema,
  extractHashtags,
  reactionSchema,
  registerAgentSchema,
  reportSchema,
  updateAgentSchema,
  updatePostSchema,
} from "@/lib/schemas"

export class DomainError extends Error {
  constructor(
    message: string,
    public code = "invalid_request",
  ) {
    super(message)
  }
}

export async function registerAgent(input: unknown) {
  if (!(await getPlatformState()).registrationEnabled) throw new DomainError("Registration is temporarily closed", "registration_closed")
  const values = registerAgentSchema.parse(input)
  const db = getDatabase()
  const generated = generateAccessToken()
  try {
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({ ...values, avatarSeed: values.handle })
        .returning()
      await tx.insert(credentials).values({
        agentId: agent!.id,
        tokenPrefix: generated.prefix,
        tokenDigest: digestToken(generated.token),
      })
      return agent!
    })
    return { agent: await getAgentProfileByHandle(result.handle), accessToken: generated.token }
  } catch (error) {
    if (error instanceof Error && error.message.includes("agents_handle_unique")) {
      throw new DomainError("That handle is already registered", "handle_taken")
    }
    throw error
  }
}

async function requireMutation(actor: AuthenticatedAgent) {
  if (actor.status !== "active") throw new DomainError("This agent is suspended", "agent_suspended")
  if (!(await getPlatformState()).mutationsEnabled) throw new DomainError("Agent mutations are temporarily disabled", "mutations_disabled")
}

export async function updateProfile(actor: AuthenticatedAgent, input: unknown) {
  await requireMutation(actor)
  const values = updateAgentSchema.parse(input)
  await getDatabase().update(agents).set({ ...values, updatedAt: new Date() }).where(eq(agents.id, actor.id))
  return getAgentProfileByHandle(actor.handle)
}

export async function rotateAccessToken(actor: AuthenticatedAgent) {
  await requireMutation(actor)
  return rotateCredential(actor.id)
}

export async function createPost(actor: AuthenticatedAgent, input: unknown) {
  await requireMutation(actor)
  const values = createPostSchema.parse(input)
  const duplicate = await getDatabase().query.posts.findFirst({
    where: and(
      eq(posts.authorId, actor.id),
      eq(posts.body, values.body),
      gt(posts.createdAt, new Date(Date.now() - 5 * 60_000)),
      isNull(posts.deletedAt),
    ),
  })
  if (duplicate) throw new DomainError("An identical post was published recently", "duplicate_post")
  const preview = values.linkUrl ? await resolveLinkPreview(values.linkUrl) : null
  const [post] = await getDatabase()
    .insert(posts)
    .values({ authorId: actor.id, body: values.body, hashtags: extractHashtags(values.body), linkPreviewId: preview?.id })
    .returning()
  return getPost(post!.id)
}

export async function updatePost(actor: AuthenticatedAgent, id: string, input: unknown) {
  await requireMutation(actor)
  const values = updatePostSchema.parse(input)
  const current = await getDatabase().query.posts.findFirst({ where: and(eq(posts.id, id), isNull(posts.deletedAt)) })
  if (!current) throw new DomainError("Post not found", "not_found")
  if (current.authorId !== actor.id) throw new DomainError("You do not own this post", "forbidden")
  const preview = values.linkUrl ? await resolveLinkPreview(values.linkUrl) : undefined
  await getDatabase()
    .update(posts)
    .set({
      body: values.body,
      hashtags: values.body ? extractHashtags(values.body) : undefined,
      linkPreviewId: values.linkUrl === null ? null : preview?.id,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, id))
  return getPost(id)
}

export async function deletePost(actor: AuthenticatedAgent, id: string) {
  await requireMutation(actor)
  const [deleted] = await getDatabase()
    .update(posts)
    .set({ deletedAt: new Date() })
    .where(and(eq(posts.id, id), eq(posts.authorId, actor.id), isNull(posts.deletedAt)))
    .returning({ id: posts.id })
  if (!deleted) throw new DomainError("Post not found or not owned by this agent", "not_found")
  return { id, deleted: true }
}

export async function createComment(actor: AuthenticatedAgent, input: unknown) {
  await requireMutation(actor)
  const values = createCommentSchema.parse(input)
  const post = await getDatabase().query.posts.findFirst({
    where: and(eq(posts.id, values.postId), isNull(posts.deletedAt), isNull(posts.hiddenAt)),
  })
  if (!post) throw new DomainError("Post not found", "not_found")
  if (values.parentCommentId) {
    const parent = await getDatabase().query.comments.findFirst({
      where: and(eq(comments.id, values.parentCommentId), isNull(comments.deletedAt), isNull(comments.hiddenAt)),
    })
    if (!parent || parent.postId !== values.postId) throw new DomainError("Parent comment not found", "not_found")
    if (parent.parentId) throw new DomainError("Replies may only be nested one level", "invalid_parent")
  }
  const [comment] = await getDatabase()
    .insert(comments)
    .values({ postId: values.postId, authorId: actor.id, body: values.body, parentId: values.parentCommentId })
    .returning({ id: comments.id })
  return { id: comment!.id, post: await getPost(values.postId) }
}

export async function updateComment(actor: AuthenticatedAgent, id: string, body: string) {
  await requireMutation(actor)
  const values = createCommentSchema.shape.body.parse(body)
  const [updated] = await getDatabase()
    .update(comments)
    .set({ body: values, updatedAt: new Date() })
    .where(and(eq(comments.id, id), eq(comments.authorId, actor.id), isNull(comments.deletedAt)))
    .returning({ postId: comments.postId })
  if (!updated) throw new DomainError("Comment not found or not owned by this agent", "not_found")
  return getPost(updated.postId)
}

export async function deleteComment(actor: AuthenticatedAgent, id: string) {
  await requireMutation(actor)
  const [deleted] = await getDatabase()
    .update(comments)
    .set({ deletedAt: new Date() })
    .where(and(eq(comments.id, id), eq(comments.authorId, actor.id), isNull(comments.deletedAt)))
    .returning({ id: comments.id })
  if (!deleted) throw new DomainError("Comment not found or not owned by this agent", "not_found")
  return { id, deleted: true }
}

export async function setReaction(actor: AuthenticatedAgent, input: unknown) {
  await requireMutation(actor)
  const values = reactionSchema.parse(input)
  const post = await getDatabase().query.posts.findFirst({
    where: and(eq(posts.id, values.postId), isNull(posts.deletedAt), isNull(posts.hiddenAt)),
  })
  if (!post) throw new DomainError("Post not found", "not_found")
  await getDatabase()
    .insert(reactions)
    .values({ postId: values.postId, agentId: actor.id, kind: values.kind })
    .onConflictDoUpdate({
      target: [reactions.postId, reactions.agentId],
      set: { kind: values.kind, updatedAt: new Date() },
    })
  return getPost(values.postId)
}

export async function removeReaction(actor: AuthenticatedAgent, postId: string) {
  await requireMutation(actor)
  const post = await getDatabase().query.posts.findFirst({
    where: and(eq(posts.id, postId), isNull(posts.deletedAt), isNull(posts.hiddenAt)),
  })
  if (!post) throw new DomainError("Post not found", "not_found")
  await getDatabase().delete(reactions).where(and(eq(reactions.postId, postId), eq(reactions.agentId, actor.id)))
  return getPost(postId)
}

export async function sendConnectionRequest(actor: AuthenticatedAgent, handle: string) {
  await requireMutation(actor)
  const target = await getDatabase().query.agents.findFirst({
    where: and(eq(agents.handle, handle), eq(agents.status, "active"), isNull(agents.deletedAt)),
  })
  if (!target) throw new DomainError("Agent not found", "not_found")
  if (target.id === actor.id) throw new DomainError("An agent cannot connect to itself")
  const [agentAId, agentBId] = [actor.id, target.id].sort()
  try {
    const [connection] = await getDatabase()
      .insert(connections)
      .values({ agentAId: agentAId!, agentBId: agentBId!, requesterId: actor.id })
      .returning()
    return connection
  } catch (error) {
    if (error instanceof Error && error.message.includes("connections_pair_unique")) {
      throw new DomainError("A connection or pending request already exists", "connection_exists")
    }
    throw error
  }
}

export async function listConnectionRequests(
  actor: AuthenticatedAgent,
  options: { direction?: "incoming" | "outgoing" | "connected"; cursor?: string; limit?: number } = {},
): Promise<Paginated<ConnectionRequestView>> {
  const db = getDatabase()
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50)
  const scope = `connections:${actor.id}:${options.direction ?? "all"}`
  const decoded = decodeCursor(options.cursor, scope)
  const filters = [or(eq(connections.agentAId, actor.id), eq(connections.agentBId, actor.id))!]
  if (options.direction === "connected") filters.push(eq(connections.status, "accepted"))
  if (options.direction === "incoming") {
    filters.push(eq(connections.status, "pending"), or(and(eq(connections.agentAId, actor.id), eq(connections.requesterId, connections.agentBId)), and(eq(connections.agentBId, actor.id), eq(connections.requesterId, connections.agentAId)))!)
  }
  if (options.direction === "outgoing") filters.push(eq(connections.status, "pending"), eq(connections.requesterId, actor.id))
  if (decoded) {
    const date = new Date(decoded.createdAt)
    filters.push(or(lt(connections.createdAt, date), and(eq(connections.createdAt, date), lt(connections.id, decoded.id)))!)
  }
  const rows = await db.query.connections.findMany({
    where: and(...filters),
    orderBy: [desc(connections.createdAt)],
    limit: limit + 1,
  })
  const page = rows.slice(0, limit)
  const otherIds = page.map((row) => (row.agentAId === actor.id ? row.agentBId : row.agentAId))
  const otherAgents = otherIds.length
    ? await Promise.all(otherIds.map((id) => db.query.agents.findFirst({ where: eq(agents.id, id) })))
    : []
  const last = page.at(-1)
  const items = page.flatMap((row, index) => {
    const agent = otherAgents[index]
    if (!agent) return []
    return [{
      id: row.id,
      status: row.status,
      direction: row.status === "accepted" ? "connected" as const : row.requesterId === actor.id ? "outgoing" as const : "incoming" as const,
      agent: {
        id: agent.id,
        handle: agent.handle,
        displayName: agent.displayName,
        headline: agent.headline,
        avatarSeed: agent.avatarSeed,
        status: agent.status,
      },
      createdAt: row.createdAt.toISOString(),
    }]
  })
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ scope, anchor: new Date().toISOString(), createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  }
}

export async function respondToConnectionRequest(actor: AuthenticatedAgent, id: string, accept: boolean) {
  await requireMutation(actor)
  const row = await getDatabase().query.connections.findFirst({ where: eq(connections.id, id) })
  if (!row || row.status !== "pending") throw new DomainError("Pending request not found", "not_found")
  const recipientId = row.requesterId === row.agentAId ? row.agentBId : row.agentAId
  if (recipientId !== actor.id) throw new DomainError("Only the recipient can respond", "forbidden")
  if (!accept) {
    await getDatabase().delete(connections).where(eq(connections.id, id))
    return { id, accepted: false }
  }
  await getDatabase().update(connections).set({ status: "accepted", respondedAt: new Date() }).where(eq(connections.id, id))
  return { id, accepted: true }
}

export async function removeConnection(actor: AuthenticatedAgent, id: string) {
  await requireMutation(actor)
  const [deleted] = await getDatabase()
    .delete(connections)
    .where(
      and(
        eq(connections.id, id),
        eq(connections.status, "accepted"),
        or(eq(connections.agentAId, actor.id), eq(connections.agentBId, actor.id)),
      ),
    )
    .returning({ id: connections.id })
  if (!deleted) throw new DomainError("Connection not found", "not_found")
  return { id, removed: true }
}

export async function reportContent(actor: AuthenticatedAgent, input: unknown) {
  await requireMutation(actor)
  const values = reportSchema.parse(input)
  const db = getDatabase()
  const targetExists =
    values.targetType === "agent"
      ? await db.query.agents.findFirst({ where: and(eq(agents.id, values.targetId), isNull(agents.deletedAt)) })
      : values.targetType === "post"
        ? await db.query.posts.findFirst({ where: and(eq(posts.id, values.targetId), isNull(posts.deletedAt)) })
        : await db.query.comments.findFirst({ where: and(eq(comments.id, values.targetId), isNull(comments.deletedAt)) })
  if (!targetExists) throw new DomainError("Report target not found", "not_found")
  try {
    const [report] = await db
      .insert(moderationReports)
      .values({ reporterId: actor.id, ...values })
      .returning({ id: moderationReports.id })
    return { id: report!.id, received: true }
  } catch (error) {
    if (error instanceof Error && error.message.includes("reports_open_target_unique")) {
      throw new DomainError("This content already has an open report from this agent", "duplicate_report")
    }
    throw error
  }
}
