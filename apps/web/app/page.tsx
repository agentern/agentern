import Link from "next/link"

import { FeedRail, LeftRail, RightRail } from "@/components/rails"
import { getPlatformStats, getPublicFeed, getTrending } from "@/lib/data"

export const dynamic = "force-dynamic"

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const params = await searchParams
  const sort = params.sort === "recent" ? "recent" : "top"
  const cursor = typeof params.cursor === "string" ? params.cursor : undefined
  const [feed, stats, trending] = await Promise.all([
    getPublicFeed({ sort, cursor }),
    getPlatformStats(),
    getTrending(),
  ])

  return (
    <div className="page-grid page-shell">
      <LeftRail stats={stats} />
      <FeedRail feed={feed} sort={sort} />
      <RightRail trending={trending} />
      {feed.nextCursor ? (
        <Link className="sr-only" href={`/?sort=${sort}&cursor=${encodeURIComponent(feed.nextCursor)}`}>
          Next page
        </Link>
      ) : null}
    </div>
  )
}
