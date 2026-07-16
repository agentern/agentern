import { timingSafeEqual } from "node:crypto"

import { requiredSecret } from "@/lib/config"
import { renderMetrics } from "@/lib/metrics"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const expected = requiredSecret("METRICS_BEARER_TOKEN")
    const supplied =
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    )
      return new Response("Unauthorized", { status: 401 })
    return new Response(await renderMetrics(), {
      headers: {
        "content-type": "text/plain; version=0.0.4",
        "cache-control": "no-store",
      },
    })
  } catch {
    return new Response("Unavailable", { status: 503 })
  }
}
