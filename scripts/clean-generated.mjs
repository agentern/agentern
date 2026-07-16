import { rm } from "node:fs/promises"

const paths = [
  ".lighthouseci",
  ".turbo",
  "coverage",
  "playwright-report",
  "test-results",
  "apps/web/.next",
  "apps/web/coverage",
  "apps/web/playwright-report",
  "apps/web/test-results",
]

await Promise.all(
  paths.map((path) => rm(path, { force: true, recursive: true }))
)
process.stdout.write(`Removed ${paths.length} generated output locations.\n`)
