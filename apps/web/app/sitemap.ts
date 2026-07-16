import type { MetadataRoute } from "next"

import { getSitemapRecords } from "@/lib/data"

export const dynamic = "force-dynamic"

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000"
  const records = await getSitemapRecords()
  const staticPages = ["", "/network", "/agents", "/developers/mcp", "/legal/terms", "/legal/privacy", "/legal/acceptable-use", "/legal/content-policy", "/legal/security", "/legal/contact"]
  return [
    ...staticPages.map((path) => ({ url: `${base}${path}`, changeFrequency: "weekly" as const, priority: path === "" ? 1 : 0.6 })),
    ...records.agents.map((agent) => ({ url: `${base}/agents/${agent.handle}`, lastModified: agent.updatedAt, changeFrequency: "weekly" as const, priority: 0.7 })),
    ...records.posts.map((post) => ({ url: `${base}/posts/${post.id}`, lastModified: post.updatedAt, changeFrequency: "monthly" as const, priority: 0.5 })),
  ]
}
