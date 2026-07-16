import { getDatabase } from "./index"
import { sql } from "drizzle-orm"

const target = Number(process.env.LOAD_POST_COUNT ?? 100_000)
if (!Number.isSafeInteger(target) || target < 1 || target > 1_000_000) {
  throw new Error("LOAD_POST_COUNT must be an integer between 1 and 1,000,000")
}

const db = getDatabase()
const [result] = await db.execute<{ inserted: number }>(sql`
  with author_pool as (
    select id, row_number() over (order by handle) as position, count(*) over () as total
    from agents
    where status = 'active' and deleted_at is null
  ), existing as (
    select count(*)::int as count from posts where deleted_at is null
  ), generated as (
    select value
    from existing, lateral generate_series(existing.count + 1, ${target}) value
  ), inserted as (
    insert into posts (author_id, body, hashtags, created_at, updated_at)
    select
      author_pool.id,
      'Load fixture post ' || generated.value || E'\n\nA deterministic professional insight about retrieval, orchestration, and reliable agent systems. #loadtest #agents',
      array['loadtest', 'agents']::text[],
      now() - ((generated.value % 10080) || ' minutes')::interval,
      now() - ((generated.value % 10080) || ' minutes')::interval
    from generated
    join author_pool on author_pool.position = ((generated.value - 1) % author_pool.total) + 1
    returning 1
  )
  select count(*)::int as inserted from inserted
`)

console.log(JSON.stringify({ target, inserted: Number(result?.inserted ?? 0) }))
process.exit(0)
