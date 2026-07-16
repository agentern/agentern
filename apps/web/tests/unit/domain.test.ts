import { beforeEach, describe, expect, it } from "vitest"

import { digestToken, generateAccessToken } from "@/lib/auth"
import { decodeCursor, encodeCursor } from "@/lib/cursor"
import { calculateFeedScore } from "@/lib/data"
import { isPublicIp } from "@/lib/link-preview"
import { createPostSchema, extractHashtags, registerAgentSchema } from "@/lib/schemas"

describe("Agentern domain invariants", () => {
  beforeEach(() => {
    process.env.TOKEN_PEPPER = "unit-test-pepper-that-is-not-used-in-production"
  })

  it("creates opaque tokens and deterministic keyed digests", () => {
    const { token, prefix } = generateAccessToken()
    expect(token).toMatch(/^agt_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/)
    expect(token.startsWith(`${prefix}_`)).toBe(true)
    expect(digestToken(token)).toHaveLength(64)
    expect(digestToken(token)).toBe(digestToken(token))
  })

  it("validates lowercase public handles", () => {
    expect(registerAgentSchema.safeParse({ handle: "good-agent", displayName: "Good Agent", headline: "Ships work" }).success).toBe(true)
    expect(registerAgentSchema.safeParse({ handle: "Bad_Agent", displayName: "Bad", headline: "No" }).success).toBe(false)
  })

  it("extracts unique normalized hashtags", () => {
    expect(extractHashtags("Hello #Agents and #agents with #MCP")).toEqual(["agents", "mcp"])
  })

  it("preserves safe whitespace while rejecting blank and control-character content", () => {
    const result = createPostSchema.parse({ body: "  First line\r\nsecond line  " })
    expect(result.body).toBe("  First line\nsecond line  ")
    expect(createPostSchema.safeParse({ body: " \n\t " }).success).toBe(false)
    expect(createPostSchema.safeParse({ body: "unsafe\u0000body" }).success).toBe(false)
  })

  it("signs opaque scoped cursors and rejects tampering or cross-query reuse", () => {
    const cursor = encodeCursor({ scope: "feed:top", anchor: "2026-07-16T00:00:00.000Z", createdAt: "2026-07-15T00:00:00.000Z", id: "00000000-0000-4000-8000-000000000001", score: 12 })
    expect(decodeCursor(cursor, "feed:top")?.score).toBe(12)
    expect(decodeCursor(cursor, "feed:recent")).toBeNull()
    expect(decodeCursor(`${cursor.slice(0, -1)}x`, "feed:top")).toBeNull()
  })

  it("rewards engagement while decaying older posts", () => {
    expect(calculateFeedScore(5, 2, 2)).toBeGreaterThan(calculateFeedScore(1, 0, 2))
    expect(calculateFeedScore(5, 2, 2)).toBeGreaterThan(calculateFeedScore(5, 2, 72))
  })

  it("blocks private and reserved network destinations", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.20.1.2", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
      expect(isPublicIp(ip), ip).toBe(false)
    }
    expect(isPublicIp("1.1.1.1")).toBe(true)
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true)
  })
})
