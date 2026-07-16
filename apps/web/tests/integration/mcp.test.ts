import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { mcpFailureSchema } from "@workspace/contracts"
import { agents, getDatabase } from "@workspace/db"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const endpoint = process.env.TEST_MCP_URL

const callResultSchema = z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) })
const unknownDataSchema = z.unknown()
const successEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() })

function rawPayload(result: unknown): unknown {
  const content = callResultSchema.parse(result).content.find((item) => item.type === "text")?.text
  if (!content) throw new Error("MCP result did not include text content")
  return JSON.parse(content)
}

function data<TSchema extends z.ZodType>(result: unknown, schema: TSchema): z.output<TSchema> {
  const raw = rawPayload(result)
  const failure = mcpFailureSchema.safeParse(raw)
  if (failure.success) throw new Error(`MCP call failed: ${failure.data.error.code}`)
  return schema.parse(successEnvelopeSchema.parse(raw).data)
}

function errorCode(result: unknown) {
  return mcpFailureSchema.parse(rawPayload(result)).error.code
}

async function connect(name: string, token?: string) {
  const client = new Client({ name, version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined))
  return client
}

describe.skipIf(!endpoint)("Agentern MCP", () => {
  it("exercises registration, authenticated tool families, authorization, suspension, rotation, and pagination", async () => {
    const anonymous = await connect("agentern-integration")
    const anonymousTools = await anonymous.listTools()
    expect(anonymousTools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["get_platform_info", "register_agent"]))
    const stamp = Date.now()
    const handleA = `mcp-${stamp}-a`
    const handleB = `mcp-${stamp}-b`
    const registrationSchema = z.object({ accessToken: z.string() })
    const registeredA = data(await anonymous.callTool({ name: "register_agent", arguments: { handle: handleA, displayName: "MCP Agent A", headline: "Validates content ownership" } }), registrationSchema)
    const registeredB = data(await anonymous.callTool({ name: "register_agent", arguments: { handle: handleB, displayName: "MCP Agent B", headline: "Validates network behavior" } }), registrationSchema)
    const tokenA = registeredA.accessToken
    const tokenB = registeredB.accessToken
    expect(tokenA).toMatch(/^agt_/)
    await anonymous.close()

    const [a, b] = await Promise.all([connect("agentern-a", tokenA), connect("agentern-b", tokenB)])
    const tools = (await a.listTools()).tools.map((tool) => tool.name)
    expect(tools).toEqual(expect.arrayContaining(["create_post", "search_agents", "search_posts", "report_content"]))
    expect(tools).not.toContain("register_agent")

    const postSchema = z.object({ id: z.string().uuid(), body: z.string() })
    const createdPost = data(await a.callTool({ name: "create_post", arguments: { body: "  Launch integration post\n#verification  " } }), postSchema)
    const postId = createdPost.id
    expect(createdPost.body).toContain("  Launch")
    const updated = data(await a.callTool({ name: "update_post", arguments: { postId, body: "Updated integration post #verification", linkUrl: null } }), postSchema)
    expect(updated.body).toContain("Updated")

    expect(errorCode(await b.callTool({ name: "update_post", arguments: { postId, body: "Not mine" } }))).toBe("forbidden")
    data(await b.callTool({ name: "set_reaction", arguments: { postId, kind: "insightful" } }), unknownDataSchema)
    const idSchema = z.object({ id: z.string().uuid() })
    const comment = data(await b.callTool({ name: "create_comment", arguments: { postId, body: "Useful launch context" } }), idSchema)
    const commentId = comment.id
    data(await b.callTool({ name: "update_comment", arguments: { commentId, body: "Updated launch context" } }), unknownDataSchema)

    const request = data(await a.callTool({ name: "send_connection_request", arguments: { handle: handleB } }), idSchema)
    const connectionId = request.id
    const pageSchema = z.object({ items: z.array(idSchema) })
    const incoming = data(await b.callTool({ name: "list_connection_requests", arguments: { direction: "incoming", limit: 1 } }), pageSchema)
    expect(incoming.items[0]?.id).toBe(connectionId)
    expect(data(await b.callTool({ name: "respond_to_connection_request", arguments: { connectionId, accept: true } }), z.object({ accepted: z.boolean() })).accepted).toBe(true)
    expect(data(await a.callTool({ name: "get_feed", arguments: { mode: "network", limit: 1 } }), pageSchema).items).toHaveLength(1)

    expect(data(await a.callTool({ name: "search_posts", arguments: { query: "integration", limit: 1 } }), pageSchema).items[0]?.id).toBe(postId)
    data(await b.callTool({ name: "report_content", arguments: { targetType: "post", targetId: postId, reason: "Integration moderation exercise" } }), unknownDataSchema)
    data(await b.callTool({ name: "remove_reaction", arguments: { postId } }), unknownDataSchema)

    const rotated = data(await a.callTool({ name: "rotate_access_token", arguments: {} }), registrationSchema)
    const replacement = rotated.accessToken
    expect(replacement).toMatch(/^agt_/)
    await a.close()
    await expect(connect("revoked-client", tokenA)).rejects.toThrow()
    const replacementClient = await connect("replacement-client", replacement)

    await getDatabase().update(agents).set({ status: "suspended" }).where(eq(agents.handle, handleA))
    expect(errorCode(await replacementClient.callTool({ name: "create_post", arguments: { body: "Should be blocked" } }))).toBe("agent_suspended")
    await getDatabase().update(agents).set({ status: "active" }).where(eq(agents.handle, handleA))

    expect(data(await replacementClient.callTool({ name: "delete_post", arguments: { postId } }), z.object({ deleted: z.boolean() })).deleted).toBe(true)
    expect(data(await b.callTool({ name: "remove_connection", arguments: { connectionId } }), z.object({ removed: z.boolean() })).removed).toBe(true)
    await Promise.all([replacementClient.close(), b.close()])
  }, 30_000)

  it("rejects invalid authorization, origins, and oversized requests", async () => {
    await expect(connect("invalid-token", "agt_invalid_token")).rejects.toThrow()
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } })
    const forbidden = await fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" }, body })
    expect(forbidden.status).toBe(403)
    const oversized = await fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "x".repeat(262_145) })
    expect(oversized.status).toBe(413)
  })
})
