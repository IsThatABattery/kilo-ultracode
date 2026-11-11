import { expect, test, type Page } from "@playwright/test"

const GLOBALS = "colorScheme:dark;theme:kilo-vscode;vscodeTheme:dark-modern"
const DRAFT = "ultracode: audit the auth module and fix what you find"

async function open(page: Page) {
  await page.goto(`/iframe.html?id=prompt-input--ultracode-keyword-420&viewMode=story&globals=${GLOBALS}`, {
    waitUntil: "load",
  })
  const input = page.locator("textarea.prompt-input")
  await expect(input).toBeVisible()
  await page.evaluate(() => window.postMessage({ type: "connectionState", state: "connected" }, window.origin))
  await expect(input).toBeEnabled()
  return input
}

/** The last sendMessage call the story recorded: [text, ...positional args, noUltracode]. */
async function sent(page: Page) {
  const raw = await page.evaluate(() => document.body.dataset.sent ?? "")
  return raw ? (JSON.parse(raw) as unknown[]) : undefined
}

const marks = (page: Page) => page.locator(".prompt-input-ultracode")

test("highlights the keyword over the exact characters the textarea shows", async ({ page }) => {
  const input = await open(page)
  await expect(input).toHaveValue(DRAFT)
  await expect(marks(page)).toHaveCount(1)
  await expect(marks(page)).toHaveText("ultracode")
  await expect(page.locator(".prompt-input-highlight-overlay")).toHaveText(DRAFT)
})

test("Backspace right after the keyword dismisses it instead of deleting a character", async ({ page }) => {
  const input = await open(page)
  await input.focus()
  await page.evaluate(() => {
    const field = document.querySelector("textarea.prompt-input") as HTMLTextAreaElement
    field.setSelectionRange(9, 9)
  })
  await input.press("Backspace")
  await expect(marks(page)).toHaveCount(0)
  await expect(input).toHaveValue(DRAFT)

  // The dismissal holds while the keyword stays in the message, and the send carries it.
  await input.press("End")
  await input.pressSequentially(" now")
  await expect(marks(page)).toHaveCount(0)
  await input.press("Enter")
  const args = await sent(page)
  expect(args?.at(0)).toBe(`${DRAFT} now`)
  expect(args?.at(-1)).toBe(true)
})

test("Alt+W dismisses, and the highlight returns once the keyword is typed again", async ({ page }) => {
  const input = await open(page)
  await input.focus()
  await input.press("Alt+KeyW")
  await expect(marks(page)).toHaveCount(0)

  await input.fill("")
  await input.pressSequentially("try ultracode")
  await expect(marks(page)).toHaveCount(1)

  await input.press("Enter")
  const args = await sent(page)
  expect(args?.at(0)).toBe("try ultracode")
  expect(args?.at(-1)).toBe(false)
})

test("a slash command never highlights the keyword", async ({ page }) => {
  const input = await open(page)
  await input.fill("/review ultracode")
  await expect(marks(page)).toHaveCount(0)
})
