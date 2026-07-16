import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"

import { getDatabase, linkPreviews } from "@workspace/db"
import { eq } from "drizzle-orm"
import ipaddr from "ipaddr.js"
import { Agent, fetch } from "undici"
import { z } from "zod"

import {
  acquireLock,
  getCachedJson,
  releaseLock,
  setCachedJson,
} from "@/lib/redis"
import { incrementMetric } from "@/lib/metrics"

const MAX_BYTES = 1_000_000
const MAX_REDIRECTS = 3
const TOTAL_TIMEOUT_MS = 4_000

export function isPublicIp(address: string) {
  if (!ipaddr.isValid(address)) return false
  let parsed = ipaddr.parse(address)
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address()
  }
  return parsed.range() === "unicast"
}

async function publicAddresses(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicIp(address))
  ) {
    throw new Error("Link resolves to a non-public address")
  }
  return addresses
}

async function assertPublicUrl(input: string) {
  const url = new URL(input)
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP(S) links are supported")
  if (url.username || url.password)
    throw new Error("Credentialed links are not supported")
  await publicAddresses(url.hostname)
  url.hash = ""
  return url
}

function decodeEntities(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
}

function meta(html: string, names: string[]) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    for (const pattern of [
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`,
        "i"
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
        "i"
      ),
    ]) {
      const match = html.match(pattern)?.[1]
      if (match) return decodeEntities(match.trim())
    }
  }
  return null
}

async function fetchHtml(
  url: URL,
  deadline: number,
  redirects = 0
): Promise<{ url: URL; html: string }> {
  const addresses = await publicAddresses(url.hostname)
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error("Link metadata request timed out")
  const pinned = addresses[0]!
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, _options, callback) {
        if (hostname !== url.hostname)
          return callback(new Error("Unexpected preview hostname"), "", 0)
        callback(null, pinned.address, pinned.family)
      },
    },
  })
  try {
    const response = await fetch(url, {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(remaining),
      headers: {
        "user-agent": "AgenternLinkPreview/1.0",
        accept: "text/html,application/xhtml+xml",
      },
    })
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= MAX_REDIRECTS) throw new Error("Too many redirects")
      const location = response.headers.get("location")
      if (!location) throw new Error("Redirect is missing a location")
      return fetchHtml(
        await assertPublicUrl(new URL(location, url).toString()),
        deadline,
        redirects + 1
      )
    }
    if (!response.ok) throw new Error(`Link returned ${response.status}`)
    const contentType = response.headers.get("content-type") ?? ""
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    )
      throw new Error("Link is not HTML")
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Link has no response body")
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES)
        throw new Error("Link metadata response is too large")
      chunks.push(value)
    }
    return { url, html: new TextDecoder().decode(Buffer.concat(chunks)) }
  } finally {
    await dispatcher.close()
  }
}

type PreviewRow = typeof linkPreviews.$inferSelect
const cachedPreviewSchema = z.object({
  id: z.string().uuid(),
  normalizedUrl: z.string().url(),
  domain: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteName: z.string().nullable(),
  fetchedAt: z.string().datetime(),
})

export async function resolveLinkPreview(input: string): Promise<PreviewRow> {
  const db = getDatabase()
  const normalized = await assertPublicUrl(input)
  const normalizedUrl = normalized.toString()
  const key = `preview:${createHash("sha256").update(normalizedUrl).digest("hex")}`
  const cached = await getCachedJson(key, cachedPreviewSchema)
  if (cached) return { ...cached, fetchedAt: new Date(cached.fetchedAt) }
  const existing = await db.query.linkPreviews.findFirst({
    where: eq(linkPreviews.normalizedUrl, normalizedUrl),
  })
  if (existing && Date.now() - existing.fetchedAt.getTime() < 86_400_000) {
    await setCachedJson(key, existing, 86_400)
    return existing
  }

  const locked = await acquireLock(key, 10)
  if (!locked && existing) return existing
  let title: string | null = null
  let description: string | null = null
  let siteName: string | null = null
  let finalUrl = normalized
  let metadataSucceeded = false
  try {
    const result = await fetchHtml(normalized, Date.now() + TOTAL_TIMEOUT_MS)
    finalUrl = result.url
    title =
      meta(result.html, ["og:title", "twitter:title"]) ??
      decodeEntities(
        result.html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? ""
      )
    description = meta(result.html, [
      "og:description",
      "twitter:description",
      "description",
    ])
    siteName = meta(result.html, ["og:site_name"])
    metadataSucceeded = true
    incrementMetric("link_preview_total", "success")
  } catch {
    // A safe domain-only preview is the intentional failure mode.
    incrementMetric("link_preview_total", "failure")
  }
  const values = {
    normalizedUrl: finalUrl.toString(),
    domain: finalUrl.hostname.replace(/^www\./, ""),
    title: title?.slice(0, 300) || null,
    description: description?.slice(0, 500) || null,
    siteName: siteName?.slice(0, 160) || null,
    fetchedAt: new Date(),
  }
  try {
    const [preview] = await db
      .insert(linkPreviews)
      .values(values)
      .onConflictDoUpdate({ target: linkPreviews.normalizedUrl, set: values })
      .returning()
    await setCachedJson(key, preview!, metadataSucceeded ? 86_400 : 3_600)
    return preview!
  } finally {
    if (locked) await releaseLock(key)
  }
}
