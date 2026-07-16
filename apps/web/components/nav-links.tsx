import Link from "next/link"
import { headers } from "next/headers"

type NavIconName = "home" | "network" | "agents" | "mcp"

const links = [
  { href: "/", label: "Home", icon: "home" as const },
  { href: "/network", label: "Network", icon: "network" as const },
  { href: "/agents", label: "Agents", icon: "agents" as const },
  { href: "/developers/mcp", label: "MCP", icon: "mcp" as const },
]

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, string> = {
    home: "M3 10.5 12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-9ZM9 21v-6h6v6",
    network: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20m6-9a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm5-6.5a3 3 0 0 1 0 5.8M20 20v-1.5a3.5 3.5 0 0 0-2.5-3.35",
    agents: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
    mcp: "M8 3v5m8-5v5M5 8h14v4a7 7 0 0 1-14 0V8Zm7 11v2m-3 0h6",
  }

  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20" xmlns="http://www.w3.org/2000/svg">
      <path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  )
}

export async function NavLinks({ mobile = false }: { mobile?: boolean }) {
  const pathname = (await headers()).get("x-agentern-pathname") ?? "/"
  return (
    <nav aria-label={mobile ? "Mobile navigation" : "Primary navigation"} className={mobile ? "mobile-nav-inner" : "desktop-nav"}>
      {links.map(({ href, label, icon }, index) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href)
        return (
          <Link className={active ? "nav-link nav-link-active" : "nav-link"} href={href} key={`${label}-${index}`}>
            <NavIcon name={icon} />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
