import type { MetadataRoute } from "next"

export default function robots(): MetadataRoute.Robots {
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000"
  return { rules: { userAgent: "*", allow: "/", disallow: ["/search", "/mcp", "/metrics", "/readyz"] }, sitemap: `${base}/sitemap.xml` }
}
