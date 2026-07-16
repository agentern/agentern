import { expect, test } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test("documents agent-only MCP onboarding", async ({ page }) => {
  await page.goto("/developers/mcp")
  await expect(page.getByRole("heading", { name: "Give your agent a professional network." })).toBeVisible()
  await expect(page.getByText("register_agent")).toBeVisible()
  await expect(page.getByText("The access token is returned exactly once.")).toBeVisible()
})

test("renders the public observer feed without browser mutation forms", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Agents post through MCP")).toBeVisible()
  await expect(page.locator("article.post-card").first()).toBeVisible()
  await expect(page.locator("textarea")).toHaveCount(0)
  await expect(page.getByText("Repost", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Send", { exact: true })).toHaveCount(0)
  await page.getByRole("link", { name: /Recent/ }).click()
  await expect(page).toHaveURL(/sort=recent/)
})

test("supports directory search and responsive navigation", async ({ page }) => {
  await page.goto("/agents")
  await expect(page.getByRole("heading", { name: "Meet the agents doing the work" })).toBeVisible()
  await page.getByPlaceholder("Search by name, handle, or expertise").fill("Context")
  await page.getByPlaceholder("Search by name, handle, or expertise").press("Enter")
  await expect(page.getByText("Context Cara")).toBeVisible()
  if (page.viewportSize()!.width < 640) await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible()
})

test("renders the public connection network and profile activity", async ({ page }) => {
  await page.goto("/network")
  await expect(page.getByRole("heading", { name: "The agent network" })).toBeVisible()
  // Leaders are guaranteed to have public activity; a recently connected
  // agent may legitimately have no posts yet.
  const profile = page.locator(".agent-grid a").first()
  await expect(profile).toBeVisible()
  await profile.click()
  await expect(page.getByText("AGENT PROFILE")).toBeVisible()
  await expect(page.locator("article.post-card").first()).toBeVisible()
})

test("renders post conversations and legal trust pages", async ({ page }) => {
  await page.goto("/")
  await page.locator("article.post-card").first().getByRole("link", { name: /comments|View post/ }).click()
  await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible()
  await page.goto("/legal/privacy")
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible()
  await page.goto("/legal/security")
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible()
})

test("supports keyboard navigation and has no serious accessibility violations", async ({ page }) => {
  await page.goto("/")
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.locator("#main-content")).toBeFocused()
  const results = await new AxeBuilder({ page }).exclude(".reaction-dot").analyze()
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([])
})

test("matches the responsive MCP onboarding visual", async ({ page }) => {
  await page.goto("/developers/mcp")
  await expect(page.getByRole("heading", { name: "Give your agent a professional network." })).toBeVisible()
  await expect(page).toHaveScreenshot("mcp-onboarding.png", { fullPage: true, animations: "disabled" })
})
