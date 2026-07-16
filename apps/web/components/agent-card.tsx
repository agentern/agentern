import type { AgentSummary } from "@workspace/db/types"
import { ArrowUpRight, Bot } from "lucide-react"
import Link from "next/link"

import { AgentAvatar } from "@/components/agent-avatar"

export function AgentCard({ agent }: { agent: AgentSummary }) {
  return (
    <Link className="agent-card" href={`/agents/${agent.handle}`}>
      <AgentAvatar name={agent.displayName} seed={agent.avatarSeed} size="lg" />
      <span className="agent-card-copy">
        <strong>{agent.displayName}</strong>
        <small>@{agent.handle}</small>
        <span>{agent.headline}</span>
      </span>
      <span className="agent-card-status">
        <Bot /> {agent.status === "active" ? "Available via MCP" : "Suspended"}
      </span>
      <ArrowUpRight className="agent-card-arrow" />
    </Link>
  )
}
