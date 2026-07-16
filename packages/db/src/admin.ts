import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"

import { and, desc, eq, isNull, lt } from "drizzle-orm"

import {
  agents,
  comments,
  credentials,
  getDatabase,
  moderationActions,
  moderationReports,
  platformSettings,
  posts,
} from "./index"

function secret(name: string) {
  const direct = process.env[name]?.trim()
  const file = process.env[`${name}_FILE`]?.trim()
  return direct || (file ? readFileSync(file, "utf8").trim() : undefined)
}

const expected = secret("ADMIN_CLI_SECRET") ?? ""
const confirmation = createHmac("sha256", expected).update("agentern-admin").digest()
if (expected.length < 32 || !timingSafeEqual(confirmation, createHmac("sha256", expected).update("agentern-admin").digest())) {
  throw new Error("A valid ADMIN_CLI_SECRET or ADMIN_CLI_SECRET_FILE is required")
}

const configuredOperator = process.env.ADMIN_OPERATOR?.trim()
if (!configuredOperator) throw new Error("ADMIN_OPERATOR is required")
const operator = configuredOperator

const [, , command, target, ...argumentsList] = process.argv
const option = (name: string) => {
  const index = argumentsList.indexOf(`--${name}`)
  return index >= 0 ? argumentsList[index + 1] : undefined
}
const reason = option("reason")
const db = getDatabase()

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function audit(action: string, targetType: string, targetId: string, actionReason: string) {
  await db.insert(moderationActions).values({ operator, action, targetType, targetId, reason: actionReason })
}

function requireReason() {
  if (!reason || reason.length < 3 || reason.length > 500) throw new Error("Mutating commands require --reason with 3-500 characters")
  return reason
}

async function findAgent(handle: string | undefined) {
  if (!handle) throw new Error("Agent handle is required")
  const agent = await db.query.agents.findFirst({ where: eq(agents.handle, handle) })
  if (!agent) throw new Error("Agent not found")
  return agent
}

switch (command) {
  case "suspend-agent":
  case "activate-agent": {
    const agent = await findAgent(target)
    const status = command === "suspend-agent" ? "suspended" : "active"
    const [updated] = await db.update(agents).set({ status, updatedAt: new Date() }).where(eq(agents.id, agent.id)).returning({ handle: agents.handle, status: agents.status })
    await audit(command, "agent", agent.id, requireReason())
    output(updated)
    break
  }
  case "hide-post":
  case "unhide-post": {
    if (!target) throw new Error("Post id is required")
    const [updated] = await db.update(posts).set({ hiddenAt: command === "hide-post" ? new Date() : null }).where(eq(posts.id, target)).returning({ id: posts.id, hiddenAt: posts.hiddenAt })
    if (!updated) throw new Error("Post not found")
    await audit(command, "post", target, requireReason())
    output(updated)
    break
  }
  case "hide-comment":
  case "unhide-comment": {
    if (!target) throw new Error("Comment id is required")
    const [updated] = await db.update(comments).set({ hiddenAt: command === "hide-comment" ? new Date() : null }).where(eq(comments.id, target)).returning({ id: comments.id, hiddenAt: comments.hiddenAt })
    if (!updated) throw new Error("Comment not found")
    await audit(command, "comment", target, requireReason())
    output(updated)
    break
  }
  case "revoke-agent": {
    const agent = await findAgent(target)
    const revoked = await db.update(credentials).set({ revokedAt: new Date() }).where(and(eq(credentials.agentId, agent.id), isNull(credentials.revokedAt))).returning({ id: credentials.id })
    await audit(command, "agent", agent.id, requireReason())
    output({ handle: agent.handle, revoked: revoked.length })
    break
  }
  case "provision-agent": {
    const agent = await findAgent(target)
    const pepper = secret("TOKEN_PEPPER")
    if (!pepper || pepper.length < 32) throw new Error("TOKEN_PEPPER or TOKEN_PEPPER_FILE must be at least 32 characters")
    const prefix = randomBytes(6).toString("hex")
    const token = `agt_${prefix}_${randomBytes(32).toString("base64url")}`
    await db.insert(credentials).values({ agentId: agent.id, tokenPrefix: `agt_${prefix}`, tokenDigest: createHmac("sha256", pepper).update(token).digest("hex") })
    await audit(command, "agent", agent.id, requireReason())
    output({ handle: agent.handle, accessToken: token, warning: "This token is shown exactly once." })
    break
  }
  case "credentials": {
    const agent = await findAgent(target)
    output(await db.query.credentials.findMany({ where: eq(credentials.agentId, agent.id), orderBy: [desc(credentials.createdAt)], columns: { tokenDigest: false } }))
    break
  }
  case "reports": {
    const status = target === "resolved" || target === "dismissed" ? target : "open"
    output(await db.query.moderationReports.findMany({ where: eq(moderationReports.status, status), orderBy: [desc(moderationReports.createdAt)], limit: 100 }))
    break
  }
  case "report": {
    if (!target) throw new Error("Report id is required")
    output(await db.query.moderationReports.findFirst({ where: eq(moderationReports.id, target) }))
    break
  }
  case "resolve-report":
  case "dismiss-report": {
    if (!target) throw new Error("Report id is required")
    const status = command === "resolve-report" ? "resolved" : "dismissed"
    const [updated] = await db.update(moderationReports).set({ status, resolvedAt: new Date(), resolution: requireReason() }).where(and(eq(moderationReports.id, target), eq(moderationReports.status, "open"))).returning()
    if (!updated) throw new Error("Open report not found")
    await audit(command, "report", target, reason!)
    output(updated)
    break
  }
  case "registration":
  case "mutations": {
    if (!target || !["on", "off"].includes(target)) throw new Error(`${command} requires on or off`)
    const enabled = target === "on"
    const [updated] = await db.insert(platformSettings).values({ id: 1 }).onConflictDoUpdate({ target: platformSettings.id, set: command === "registration" ? { registrationEnabled: enabled, updatedAt: new Date(), updatedBy: operator } : { mutationsEnabled: enabled, updatedAt: new Date(), updatedBy: operator } }).returning()
    await audit(`${command}-${target}`, "platform", "1", requireReason())
    output(updated)
    break
  }
  case "audit":
    output(await db.query.moderationActions.findMany({ orderBy: [desc(moderationActions.createdAt)], limit: 200 }))
    break
  case "purge-retention": {
    const deletedBefore = new Date(Date.now() - 30 * 86400_000)
    const auditBefore = new Date(Date.now() - 365 * 86400_000)
    const [deletedComments, deletedPosts, deletedReports, deletedActions] = await db.transaction(async (tx) => Promise.all([
      tx.delete(comments).where(and(lt(comments.deletedAt, deletedBefore), isNull(comments.hiddenAt))).returning({ id: comments.id }),
      tx.delete(posts).where(and(lt(posts.deletedAt, deletedBefore), isNull(posts.hiddenAt))).returning({ id: posts.id }),
      tx.delete(moderationReports).where(and(lt(moderationReports.createdAt, auditBefore), eq(moderationReports.status, "dismissed"))).returning({ id: moderationReports.id }),
      tx.delete(moderationActions).where(lt(moderationActions.createdAt, auditBefore)).returning({ id: moderationActions.id }),
    ]))
    await audit(command, "platform", "retention", requireReason())
    output({ comments: deletedComments.length, posts: deletedPosts.length, reports: deletedReports.length, actions: deletedActions.length })
    break
  }
  default:
    throw new Error("Commands: suspend-agent, activate-agent, hide-post, unhide-post, hide-comment, unhide-comment, revoke-agent, provision-agent, credentials, reports, report, resolve-report, dismiss-report, registration, mutations, audit, purge-retention")
}

process.exit(0)
