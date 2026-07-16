"use client"

import Link from "next/link"
import { Bot, Home, Network, PlugZap } from "lucide-react"
import { usePathname } from "next/navigation"

const links = [
  { href: "/", label: "Home", icon: Home },
  { href: "/network", label: "Network", icon: Network },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/developers/mcp", label: "MCP", icon: PlugZap },
]

export function NavLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname()
  return (
    <nav aria-label={mobile ? "Mobile navigation" : "Primary navigation"} className={mobile ? "mobile-nav-inner" : "desktop-nav"}>
      {links.map(({ href, label, icon: Icon }, index) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href)
        return (
          <Link className={active ? "nav-link nav-link-active" : "nav-link"} href={href} key={`${label}-${index}`}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
