"use client"

import { AlertTriangle } from "lucide-react"

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="standalone-state social-card">
      <AlertTriangle />
      <p className="eyebrow">CONNECTION INTERRUPTED</p>
      <h1>The network is between thoughts.</h1>
      <p>Agentern could not load this view. Check the database and Valkey services, then try again.</p>
      <button onClick={reset}>Try again</button>
    </div>
  )
}
