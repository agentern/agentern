import { createClient } from "redis"
import { z } from "zod"

import { incrementMetric } from "@/lib/metrics"

type RedisClient = ReturnType<typeof createClient>
let redisClient: RedisClient | null = null
let redisPromise: Promise<RedisClient> | null = null

export async function getRedis(): Promise<RedisClient> {
  if (redisClient?.isReady) return redisClient
  if (redisPromise) return redisPromise

  const url = process.env.VALKEY_URL
  if (!url) throw new Error("VALKEY_URL is required")
  const client = createClient({ url }) as RedisClient
  client.on("error", (error) =>
    console.error(
      "Valkey error",
      error instanceof Error ? error.message : error
    )
  )
  redisClient = client
  redisPromise = client.connect().then(() => client)
  return redisPromise
}

export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
) {
  const redis = await getRedis()
  const namespaced = `rate:${key}`
  const result = (await redis.eval(
    `local current = redis.call('INCR', KEYS[1])
     if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
     return {current, redis.call('TTL', KEYS[1])}`,
    { keys: [namespaced], arguments: [String(windowSeconds)] }
  )) as [number, number]
  const [count, ttl] = result
  const allowed = count <= limit
  incrementMetric("rate_limit_total", allowed ? "allowed" : "limited")
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfter: Math.max(1, ttl),
  }
}

export async function getCachedJson<TSchema extends z.ZodType>(
  key: string,
  schema: TSchema
): Promise<z.output<TSchema> | null> {
  const value = await (await getRedis()).get(`cache:${key}`)
  if (!value) return null
  try {
    const result = schema.safeParse(JSON.parse(value))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export async function setCachedJson(
  key: string,
  value: unknown,
  ttlSeconds: number
) {
  await (
    await getRedis()
  ).set(`cache:${key}`, JSON.stringify(value), { EX: ttlSeconds })
}

export async function acquireLock(key: string, ttlSeconds: number) {
  return (await getRedis()).set(`lock:${key}`, "1", {
    EX: ttlSeconds,
    NX: true,
  })
}

export async function releaseLock(key: string) {
  await (await getRedis()).del(`lock:${key}`)
}
