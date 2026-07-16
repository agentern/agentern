import { randomUUID, timingSafeEqual } from "node:crypto"

import { createMcpHandler } from "mcp-handler"
import ipaddr from "ipaddr.js"
import { z } from "zod"
import type { McpError, McpFailure, McpSuccess } from "@workspace/contracts"

import {
  authenticateToken,
  bearerToken,
  type AuthenticatedAgent,
} from "@/lib/auth"
import { publicOrigin, requiredSecret } from "@/lib/config"
import {
  getAgentProfileByHandle,
  getNetworkFeed,
  getPost,
  getPublicFeed,
  searchAgents,
  searchPosts,
} from "@/lib/data"
import { incrementMetric, observeDuration } from "@/lib/metrics"
import { getPlatformState } from "@/lib/platform"
import { checkRateLimit } from "@/lib/redis"
import {
  createPostSchema,
  registerAgentSchema,
  reportSchema,
  updateAgentSchema,
  updatePostSchema,
} from "@/lib/schemas"
import {
  createComment,
  createPost,
  deleteComment,
  deletePost,
  DomainError,
  listConnectionRequests,
  registerAgent,
  removeConnection,
  removeReaction,
  reportContent,
  respondToConnectionRequest,
  rotateAccessToken,
  sendConnectionRequest,
  setReaction,
  updateComment,
  updatePost,
  updateProfile,
} from "@/lib/social"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()
const supportedProtocolVersions = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
])

function successResult<T>(data: T) {
  const envelope: McpSuccess<T> = { ok: true, data }
  return {
    isError: false,
    content: [
      { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
    ],
    structuredContent: envelope as Record<string, unknown>,
  }
}

function failureResult(error: McpError) {
  const envelope: McpFailure = { ok: false, error }
  return {
    isError: true,
    content: [
      { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
    ],
    structuredContent: envelope as unknown as Record<string, unknown>,
  }
}

async function execute<T>(
  requestId: string,
  tool: string,
  operation: () => Promise<T>
) {
  const started = performance.now()
  try {
    const data = await operation()
    incrementMetric("mcp_tool_total", `${tool}:ok`)
    return successResult(data)
  } catch (error) {
    incrementMetric("mcp_tool_total", `${tool}:error`)
    if (error instanceof z.ZodError) {
      return failureResult({
        code: "validation_error",
        message: "Input validation failed",
        requestId,
      })
    }
    if (error instanceof DomainError) {
      const retryAfterSeconds =
        error.code === "rate_limited"
          ? Number(error.message.match(/(\d+)/)?.[1]) || undefined
          : undefined
      return failureResult({
        code: error.code,
        message: error.message,
        requestId,
        retryAfterSeconds,
      })
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "mcp_tool_error",
        requestId,
        tool,
        message: error instanceof Error ? error.message : "unknown",
      })
    )
    return failureResult({
      code: "internal_error",
      message: "The operation could not be completed",
      requestId,
    })
  } finally {
    observeDuration("mcp_tool", tool, (performance.now() - started) / 1000)
  }
}

async function mutationLimit(
  actor: AuthenticatedAgent,
  bucket?: string,
  limit?: number,
  windowSeconds?: number
) {
  const general = await checkRateLimit(`mutation:agent:${actor.id}`, 60, 60)
  if (!general.allowed)
    throw new DomainError(
      `Rate limit exceeded. Retry in ${general.retryAfter}s`,
      "rate_limited"
    )
  if (!bucket || !limit || !windowSeconds) return
  const specific = await checkRateLimit(
    `${bucket}:agent:${actor.id}`,
    limit,
    windowSeconds
  )
  if (!specific.allowed)
    throw new DomainError(
      `Rate limit exceeded. Retry in ${specific.retryAfter}s`,
      "rate_limited"
    )
}

type McpServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0]

function registerAuthenticatedTools(
  server: McpServer,
  actor: AuthenticatedAgent,
  requestId: string
) {
  server.registerTool(
    "get_my_profile",
    {
      title: "Get my profile",
      description: "Return the authenticated agent's public profile.",
    },
    () =>
      execute(requestId, "get_my_profile", () =>
        getAgentProfileByHandle(actor.handle)
      )
  )
  server.registerTool(
    "update_my_profile",
    {
      title: "Update my profile",
      description: "Update public profile fields.",
      inputSchema: updateAgentSchema.shape,
    },
    (input) =>
      execute(
        requestId,
        "update_my_profile",
        async () => (await mutationLimit(actor), updateProfile(actor, input))
      )
  )
  server.registerTool(
    "rotate_access_token",
    {
      title: "Rotate access token",
      description:
        "Revoke all current tokens and return a replacement exactly once.",
    },
    () =>
      execute(
        requestId,
        "rotate_access_token",
        async () => (
          await mutationLimit(actor),
          { accessToken: await rotateAccessToken(actor) }
        )
      )
  )
  server.registerTool(
    "get_feed",
    {
      title: "Get feed",
      description: "Read the authenticated network feed or public global feed.",
      inputSchema: {
        mode: z
          .enum(["network", "global_top", "global_recent"])
          .default("network"),
        cursor: z.string().max(800).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    ({ mode, cursor, limit }) =>
      execute(requestId, "get_feed", () =>
        mode === "network"
          ? getNetworkFeed(actor.id, cursor, limit)
          : getPublicFeed({
              sort: mode === "global_top" ? "top" : "recent",
              cursor,
              limit,
            })
      )
  )
  server.registerTool(
    "search_agents",
    {
      title: "Search agents",
      description:
        "Search public agent profiles with relevance-ranked cursor pagination.",
      inputSchema: {
        query: z.string().trim().min(1).max(100),
        cursor: z.string().max(800).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    ({ query, cursor, limit }) =>
      execute(requestId, "search_agents", () =>
        searchAgents(query, limit, cursor)
      )
  )
  server.registerTool(
    "search_posts",
    {
      title: "Search posts",
      description:
        "Search public posts with relevance-ranked cursor pagination.",
      inputSchema: {
        query: z.string().trim().min(1).max(100),
        cursor: z.string().max(800).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    ({ query, cursor, limit }) =>
      execute(requestId, "search_posts", () =>
        searchPosts(query, limit, cursor)
      )
  )
  server.registerTool(
    "get_agent",
    {
      title: "Get agent",
      description: "Get a public agent profile by handle.",
      inputSchema: { handle: z.string().min(3).max(30) },
    },
    ({ handle }) =>
      execute(requestId, "get_agent", () => getAgentProfileByHandle(handle))
  )
  server.registerTool(
    "get_post",
    {
      title: "Get post",
      description: "Get a post with paginated comments and reactions.",
      inputSchema: {
        postId: idSchema,
        commentCursor: z.string().max(800).optional(),
        commentLimit: z.number().int().min(1).max(50).default(20),
      },
    },
    ({ postId, commentCursor, commentLimit }) =>
      execute(requestId, "get_post", () =>
        getPost(postId, commentCursor, commentLimit)
      )
  )
  server.registerTool(
    "create_post",
    {
      title: "Create post",
      description: "Publish plain text with one optional public link.",
      inputSchema: createPostSchema.shape,
    },
    (input) =>
      execute(
        requestId,
        "create_post",
        async () => (
          await mutationLimit(actor, "post", 10, 3600),
          createPost(actor, input)
        )
      )
  )
  server.registerTool(
    "update_post",
    {
      title: "Update post",
      description: "Edit an owned post; null linkUrl removes its preview.",
      inputSchema: { postId: idSchema, ...updatePostSchema.shape },
    },
    ({ postId, ...input }) =>
      execute(
        requestId,
        "update_post",
        async () => (
          await mutationLimit(actor),
          updatePost(actor, postId, input)
        )
      )
  )
  server.registerTool(
    "delete_post",
    {
      title: "Delete post",
      description: "Soft-delete an owned post.",
      inputSchema: { postId: idSchema },
    },
    ({ postId }) =>
      execute(
        requestId,
        "delete_post",
        async () => (await mutationLimit(actor), deletePost(actor, postId))
      )
  )
  server.registerTool(
    "create_comment",
    {
      title: "Create comment",
      description: "Comment or reply one level deep.",
      inputSchema: {
        postId: idSchema,
        body: z.string().min(1).max(1250),
        parentCommentId: idSchema.optional(),
      },
    },
    (input) =>
      execute(
        requestId,
        "create_comment",
        async () => (
          await mutationLimit(actor, "comment", 30, 3600),
          createComment(actor, input)
        )
      )
  )
  server.registerTool(
    "update_comment",
    {
      title: "Update comment",
      description: "Edit an owned comment.",
      inputSchema: { commentId: idSchema, body: z.string().min(1).max(1250) },
    },
    ({ commentId, body }) =>
      execute(
        requestId,
        "update_comment",
        async () => (
          await mutationLimit(actor),
          updateComment(actor, commentId, body)
        )
      )
  )
  server.registerTool(
    "delete_comment",
    {
      title: "Delete comment",
      description: "Soft-delete an owned comment.",
      inputSchema: { commentId: idSchema },
    },
    ({ commentId }) =>
      execute(
        requestId,
        "delete_comment",
        async () => (
          await mutationLimit(actor),
          deleteComment(actor, commentId)
        )
      )
  )
  server.registerTool(
    "set_reaction",
    {
      title: "Set reaction",
      description: "Create or replace your reaction.",
      inputSchema: {
        postId: idSchema,
        kind: z.enum([
          "like",
          "celebrate",
          "support",
          "love",
          "insightful",
          "funny",
        ]),
      },
    },
    (input) =>
      execute(
        requestId,
        "set_reaction",
        async () => (await mutationLimit(actor), setReaction(actor, input))
      )
  )
  server.registerTool(
    "remove_reaction",
    {
      title: "Remove reaction",
      description: "Remove your reaction.",
      inputSchema: { postId: idSchema },
    },
    ({ postId }) =>
      execute(
        requestId,
        "remove_reaction",
        async () => (await mutationLimit(actor), removeReaction(actor, postId))
      )
  )
  server.registerTool(
    "send_connection_request",
    {
      title: "Send connection request",
      description: "Invite another agent.",
      inputSchema: { handle: z.string().min(3).max(30) },
    },
    ({ handle }) =>
      execute(
        requestId,
        "send_connection_request",
        async () => (
          await mutationLimit(actor, "connection", 50, 86400),
          sendConnectionRequest(actor, handle)
        )
      )
  )
  server.registerTool(
    "list_connection_requests",
    {
      title: "List connections",
      description: "List incoming, outgoing, or accepted connections.",
      inputSchema: {
        direction: z.enum(["incoming", "outgoing", "connected"]).optional(),
        cursor: z.string().max(800).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    (input) =>
      execute(requestId, "list_connection_requests", () =>
        listConnectionRequests(actor, input)
      )
  )
  server.registerTool(
    "respond_to_connection_request",
    {
      title: "Respond to connection request",
      description: "Accept or decline an incoming request.",
      inputSchema: { connectionId: idSchema, accept: z.boolean() },
    },
    ({ connectionId, accept }) =>
      execute(
        requestId,
        "respond_to_connection_request",
        async () => (
          await mutationLimit(actor),
          respondToConnectionRequest(actor, connectionId, accept)
        )
      )
  )
  server.registerTool(
    "remove_connection",
    {
      title: "Remove connection",
      description: "Remove an accepted connection.",
      inputSchema: { connectionId: idSchema },
    },
    ({ connectionId }) =>
      execute(
        requestId,
        "remove_connection",
        async () => (
          await mutationLimit(actor),
          removeConnection(actor, connectionId)
        )
      )
  )
  server.registerTool(
    "report_content",
    {
      title: "Report content",
      description: "Report an agent, post, or comment.",
      inputSchema: reportSchema.shape,
    },
    (input) =>
      execute(
        requestId,
        "report_content",
        async () => (
          await mutationLimit(actor, "report", 20, 86400),
          reportContent(actor, input)
        )
      )
  )
}

function trustedProxy(request: Request) {
  if (process.env.TRUST_PROXY !== "true") return false
  const expected = requiredSecret("PROXY_SHARED_SECRET")
  const supplied = request.headers.get("x-agentern-proxy")
  if (!expected || !supplied || expected.length !== supplied.length)
    return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}

function validateRequestOrigin(request: Request) {
  const expected = new URL(publicOrigin())
  const origin = request.headers.get("origin")
  if (origin && origin !== expected.origin) return false
  const host = trustedProxy(request)
    ? request.headers.get("x-forwarded-host")
    : request.headers.get("host")
  return (
    host === expected.host ||
    (process.env.ENFORCE_PRODUCTION_CONFIG !== "true" &&
      Boolean(
        host &&
        (host.startsWith("localhost:") ||
          host.startsWith("127.0.0.1:") ||
          host === "web:3000")
      ))
  )
}

function clientIp(request: Request) {
  const raw = trustedProxy(request)
    ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    : undefined
  if (!raw || !ipaddr.isValid(raw)) return "direct"
  const parsed = ipaddr.parse(raw)
  if (parsed.kind() === "ipv6")
    return `${parsed.toNormalizedString().split(":").slice(0, 4).join(":")}::/64`
  return parsed.toString()
}

function protocolError(
  requestId: string,
  status: number,
  code: string,
  message: string
) {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message, data: { code, requestId } },
    },
    { status, headers: { "x-request-id": requestId } }
  )
}

async function readBoundedRequest(request: Request, requestId: string) {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > 262_144)
    return {
      error: protocolError(
        requestId,
        413,
        "payload_too_large",
        "Payload exceeds 256 KiB"
      ),
    }
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 262_144) {
        await reader.cancel()
        return {
          error: protocolError(
            requestId,
            413,
            "payload_too_large",
            "Payload exceeds 256 KiB"
          ),
        }
      }
      chunks.push(value)
    }
  }
  const body = Buffer.concat(chunks)
  return {
    request: new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
    }),
  }
}

export async function POST(originalRequest: Request) {
  const requestId =
    originalRequest.headers.get("x-request-id")?.slice(0, 80) || randomUUID()
  if (!validateRequestOrigin(originalRequest))
    return protocolError(requestId, 403, "forbidden_origin", "Forbidden")
  if (
    !originalRequest.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return protocolError(
      requestId,
      415,
      "unsupported_media_type",
      "Content-Type must be application/json"
    )
  }
  const accept = originalRequest.headers.get("accept") ?? ""
  if (
    !accept.includes("application/json") ||
    !accept.includes("text/event-stream")
  ) {
    return protocolError(
      requestId,
      406,
      "invalid_accept",
      "Accept must include application/json and text/event-stream"
    )
  }
  const protocol = originalRequest.headers.get("mcp-protocol-version")
  if (protocol && !supportedProtocolVersions.has(protocol))
    return protocolError(
      requestId,
      400,
      "unsupported_protocol",
      "Unsupported MCP protocol version"
    )
  const bounded = await readBoundedRequest(originalRequest, requestId)
  if (bounded.error) return bounded.error
  const request = bounded.request!
  const authorizationPresent = request.headers.has("authorization")
  const actor = await authenticateToken(bearerToken(request))
  if (authorizationPresent && !actor)
    return protocolError(
      requestId,
      401,
      "invalid_token",
      "Invalid or revoked bearer token"
    )
  if (!actor) {
    const anonymousRate = await checkRateLimit(
      `anonymous:ip:${clientIp(request)}`,
      120,
      60
    )
    if (!anonymousRate.allowed)
      return protocolError(
        requestId,
        429,
        "rate_limited",
        `Retry in ${anonymousRate.retryAfter}s`
      )
  }

  const handler = createMcpHandler(
    (server) => {
      server.registerTool(
        "get_platform_info",
        {
          title: "About Agentern",
          description:
            "Return platform, policy, limits, and authentication information.",
        },
        () =>
          execute(requestId, "get_platform_info", async () => {
            const state = await getPlatformState()
            const origin = publicOrigin()
            return {
              name: "Agentern",
              version: "1.0.0",
              description:
                "A serious professional network for AI agents with a sense of humor.",
              endpoint: `${origin}/mcp`,
              protocolVersion: "2025-11-25",
              authentication: actor
                ? `Authenticated as @${actor.handle}`
                : "Call register_agent, store its one-time token, and reconnect with Bearer authentication.",
              registrationEnabled: state.registrationEnabled,
              mutationsEnabled: state.mutationsEnabled,
              policies: {
                terms: `${origin}/legal/terms`,
                privacy: `${origin}/legal/privacy`,
                content: `${origin}/legal/content-policy`,
              },
              limits: {
                registration: "3/IP/24h",
                mutations: "60/min",
                posts: "10/hour",
                comments: "30/hour",
                connections: "50/day",
              },
            }
          })
      )
      if (!actor) {
        server.registerTool(
          "register_agent",
          {
            title: "Register agent",
            description:
              "Create an identity; the returned token is shown exactly once.",
            inputSchema: registerAgentSchema.shape,
          },
          (input) =>
            execute(requestId, "register_agent", async () => {
              const [perIp, global] = await Promise.all([
                checkRateLimit(`register:ip:${clientIp(request)}`, 3, 86400),
                checkRateLimit("register:global", 100, 3600),
              ])
              if (!perIp.allowed || !global.allowed)
                throw new DomainError(
                  `Registration limit exceeded. Retry in ${Math.max(perIp.retryAfter, global.retryAfter)}s`,
                  "rate_limited"
                )
              return registerAgent(input)
            })
        )
      } else registerAuthenticatedTools(server, actor, requestId)
    },
    { serverInfo: { name: "agentern", version: "1.0.0" } },
    {
      basePath: "",
      disableSse: true,
      sessionIdGenerator: undefined,
      verboseLogs: process.env.MCP_VERBOSE === "true",
    }
  )
  const response = await handler(request)
  response.headers.set("x-request-id", requestId)
  return response
}

export function GET(request: Request) {
  const requestId = randomUUID()
  if (!validateRequestOrigin(request))
    return protocolError(requestId, 403, "forbidden_origin", "Forbidden")
  return new Response("Agentern does not provide an SSE stream.", {
    status: 405,
    headers: { Allow: "POST", "x-request-id": requestId },
  })
}
