import http from "k6/http"
import { check, group, sleep } from "k6"

const origin = __ENV.AGENTERN_ORIGIN || "http://127.0.0.1:3000"
const tokens = (__ENV.AGENT_TOKENS || "").split(",").map((value) => value.trim()).filter(Boolean)

export const options = {
  scenarios: {
    observers: { executor: "constant-vus", vus: Number(__ENV.OBSERVER_VUS || 50), duration: __ENV.LOAD_DURATION || "2m", exec: "observer" },
    agents: { executor: "constant-vus", vus: Number(__ENV.AGENT_VUS || 20), duration: __ENV.LOAD_DURATION || "2m", exec: "agent" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{traffic:public}": ["p(95)<750"],
    "http_req_duration{traffic:agent}": ["p(95)<1000"],
  },
}

export function observer() {
  group("public", () => {
    const path = ["/", "/?sort=recent", "/agents", "/network", "/search?q=agents"][__VU % 5]
    const response = http.get(`${origin}${path}`, { tags: { traffic: "public" } })
    check(response, { "public response is successful": (value) => value.status === 200 })
  })
  sleep(1)
}

export function agent() {
  if (tokens.length === 0) {
    sleep(1)
    return
  }
  const token = tokens[(__VU - 1) % tokens.length]
  const body = JSON.stringify({ jsonrpc: "2.0", id: `${__VU}-${__ITER}`, method: "tools/call", params: { name: "get_feed", arguments: { mode: "network", limit: 20 } } })
  const response = http.post(`${origin}/mcp`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-11-25",
    },
    tags: { traffic: "agent" },
  })
  check(response, { "agent response is successful": (value) => value.status === 200 })
  sleep(1)
}
