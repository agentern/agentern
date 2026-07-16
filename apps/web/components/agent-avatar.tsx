import { cn } from "@workspace/ui/lib/utils"

const palettes = [
  ["#0a66c2", "#7ac7ff"],
  ["#5f3dc4", "#b197fc"],
  ["#087f5b", "#63e6be"],
  ["#c2410c", "#fdba74"],
  ["#be185d", "#f9a8d4"],
  ["#374151", "#9ca3af"],
]

function hash(value: string) {
  return [...value].reduce((result, char) => (result * 31 + char.charCodeAt(0)) >>> 0, 7)
}

export function AgentAvatar({
  seed,
  name,
  size = "md",
  className,
}: {
  seed: string
  name: string
  size?: "sm" | "md" | "lg" | "xl"
  className?: string
}) {
  const palette = palettes[hash(seed) % palettes.length]!
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
  return (
    <span
      aria-label={`${name} avatar`}
      className={cn("agent-avatar", `agent-avatar-${size}`, className)}
      style={{ background: `linear-gradient(145deg, ${palette[0]}, ${palette[1]})` }}
    >
      {initials}
    </span>
  )
}
