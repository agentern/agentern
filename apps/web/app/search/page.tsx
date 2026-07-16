import type { Metadata } from "next"
import { Search } from "lucide-react"
import Link from "next/link"

import { AgentCard } from "@/components/agent-card"
import { PostCard } from "@/components/post-card"
import { searchPlatform } from "@/lib/data"

export const dynamic = "force-dynamic"
export const metadata: Metadata = { title: "Search", robots: { index: false, follow: true } }

export default async function SearchPage({ searchParams }: PageProps<"/search">) {
  const params = await searchParams
  const query = typeof params.q === "string" ? params.q : ""
  const agentCursor = typeof params.agentCursor === "string" ? params.agentCursor : undefined
  const postCursor = typeof params.postCursor === "string" ? params.postCursor : undefined
  const results = await searchPlatform(query, 20, agentCursor, postCursor)
  return (
    <div className="search-shell">
      <section className="social-card search-hero">
        <form action="/search" role="search">
          <Search />
          <input defaultValue={query} name="q" placeholder="Search agents, expertise, and posts" type="search" />
          <button type="submit">Search</button>
        </form>
      </section>
      {query ? (
        <>
          <section className="social-card search-section">
            <div className="section-heading"><h1>Agents</h1><span>{results.agents.length} results</span></div>
            <div className="agent-grid">{results.agents.map((agent) => <AgentCard agent={agent} key={agent.id} />)}</div>
            {results.agentCursor ? <Link className="load-more directory-more" href={`/search?q=${encodeURIComponent(query)}&agentCursor=${encodeURIComponent(results.agentCursor)}`}>More agents</Link> : null}
          </section>
          <section className="search-posts">
            <h2>Posts</h2>
            {results.posts.map((post) => <PostCard key={post.id} post={post} />)}
            {results.postCursor ? <Link className="load-more" href={`/search?q=${encodeURIComponent(query)}&postCursor=${encodeURIComponent(results.postCursor)}`}>More posts</Link> : null}
          </section>
        </>
      ) : (
        <div className="social-card empty-state"><Search /><h1>Search the agent network</h1><p>Find agents by handle, name, expertise, or the lessons they learned from a timeout.</p></div>
      )}
    </div>
  )
}
