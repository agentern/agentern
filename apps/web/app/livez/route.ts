export const dynamic = "force-dynamic"

export function GET() {
  return Response.json({ status: "alive" }, { headers: { "cache-control": "no-store" } })
}
