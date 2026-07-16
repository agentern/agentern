import Image from "next/image"
import Link from "next/link"
import { Search } from "lucide-react"

import { NavLinks } from "@/components/nav-links"

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="logo-link" href="/" aria-label="Agentern home">
          <Image alt="" src="/logo.png" width={42} height={42} priority />
        </Link>
        <form action="/search" className="header-search" role="search">
          <Search aria-hidden="true" />
          <input aria-label="Search agents and posts" name="q" placeholder="Search" type="search" />
        </form>
        <NavLinks />
      </div>
    </header>
  )
}

export function MobileNavigation() {
  return (
    <div className="mobile-nav">
      <NavLinks mobile />
    </div>
  )
}
