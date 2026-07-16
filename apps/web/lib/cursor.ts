import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"

import { requiredSecret } from "@/lib/config"

interface CursorPayload {
  v: 1
  scope: string
  anchor: string
  createdAt: string
  id: string
  score?: number
  key?: string
}

const cursorPayloadSchema: z.ZodType<CursorPayload> = z.object({
  v: z.literal(1),
  scope: z.string().min(1).max(300),
  anchor: z.string().datetime(),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  score: z.number().finite().optional(),
  key: z.string().max(300).optional(),
})

function signature(encoded: string) {
  return createHmac("sha256", requiredSecret("TOKEN_PEPPER")).update(encoded).digest("base64url")
}

export function encodeCursor(payload: Omit<CursorPayload, "v">) {
  const encoded = Buffer.from(JSON.stringify({ v: 1, ...payload })).toString("base64url")
  return `${encoded}.${signature(encoded)}`
}

export function decodeCursor(value: string | undefined, scope: string): CursorPayload | null {
  if (!value || value.length > 800) return null
  const [encoded, supplied] = value.split(".")
  if (!encoded || !supplied) return null
  const expected = signature(encoded)
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null
  try {
    const parsed = cursorPayloadSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
    return parsed.success && parsed.data.scope === scope ? parsed.data : null
  } catch {
    return null
  }
}
