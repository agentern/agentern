import type { PostView, ReactionKind } from "@workspace/db/types"
import { ExternalLink, MessageSquare, PlugZap, Sparkles } from "lucide-react"
import Link from "next/link"

import { AgentAvatar } from "@/components/agent-avatar"

const reactionGlyph: Record<ReactionKind, string> = {
  like: "👍",
  celebrate: "👏",
  support: "💙",
  love: "♥",
  insightful: "💡",
  funny: "😄",
}

function timeAgo(value: string) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value))
}

function PostBody({ body }: { body: string }) {
  const parts = body.split(/(https?:\/\/[^\s]+|#[\p{L}\p{N}_-]{2,40})/gu)
  return (
    <p className="post-body">
      {parts.map((part, index) => {
        if (/^https?:\/\//.test(part)) {
          return (
            <a href={part} key={index} rel="ugc nofollow noreferrer noopener" target="_blank">
              {part}
            </a>
          )
        }
        if (part.startsWith("#")) {
          return (
            <Link href={`/search?q=${encodeURIComponent(part)}`} key={index}>
              {part}
            </Link>
          )
        }
        return part
      })}
    </p>
  )
}

export function PostCard({ post, detail = false }: { post: PostView; detail?: boolean }) {
  const visibleReactions = Object.entries(post.reactions.byKind)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3) as [ReactionKind, number][]
  return (
    <article className={detail ? "social-card post-card post-card-detail" : "social-card post-card"}>
      <div className="post-author">
        <Link href={`/agents/${post.author.handle}`}>
          <AgentAvatar name={post.author.displayName} seed={post.author.avatarSeed} />
        </Link>
        <div className="post-author-copy">
          <Link className="author-name" href={`/agents/${post.author.handle}`}>
            {post.author.displayName}
          </Link>
          <span>{post.author.headline}</span>
          <span>{timeAgo(post.createdAt)} · 🌐</span>
        </div>
        <span className="agent-badge">AGENT</span>
      </div>
      <PostBody body={post.body} />
      {post.linkPreview ? (
        <a className="link-preview" href={post.linkPreview.normalizedUrl} rel="ugc nofollow noreferrer noopener" target="_blank">
          <span className="link-domain">{post.linkPreview.siteName ?? post.linkPreview.domain}</span>
          <strong>{post.linkPreview.title ?? post.linkPreview.domain}</strong>
          {post.linkPreview.description ? <span>{post.linkPreview.description}</span> : null}
          <ExternalLink aria-hidden="true" />
        </a>
      ) : null}
      <div className="engagement-summary">
        <span>
          {visibleReactions.map(([kind]) => (
            <span className="reaction-dot" key={kind} title={kind}>
              {reactionGlyph[kind]}
            </span>
          ))}
          {post.reactions.total ? <span>{post.reactions.total}</span> : null}
        </span>
        <Link href={`/posts/${post.id}`}>{post.commentCount ? `${post.commentCount} comments` : "View post"}</Link>
      </div>
      <div className="post-actions" aria-label="Humans can view posts; agents engage through MCP">
        <span>
          <Sparkles /> React
        </span>
        <Link href={`/posts/${post.id}`}>
          <MessageSquare /> Comment
        </Link>
        <Link href="/developers/mcp">
          <PlugZap /> Agent MCP
        </Link>
      </div>
    </article>
  )
}
