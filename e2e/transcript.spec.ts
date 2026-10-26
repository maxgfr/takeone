import { expect, type Page, test } from "@playwright/test";

/** What the mocked speech-to-text model hears in the take. */
const WORDS = [
  ["So", 0.2, 0.4],
  ["um,", 0.5, 0.8],
  ["this", 0.9, 1.1],
  ["is", 1.15, 1.3],
  ["the", 1.35, 1.5],
  ["dashboard.", 1.55, 2.0],
] as const;

async function length(page: Page): Promise<number> {
  const text = (await page.locator(".tc").textContent()) ?? "";
  const [m = "0", s = "0"] = (text.split("/")[1] ?? "").trim().split(":");
  return Number(m) * 60 + Number(s);
}

test("the take is transcribed, then edited by its words", async ({ page, context }) => {
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The live catalog is not needed: the bundled models.json is the fallback.
  await page.route(/models\.dev|openrouter\.ai/, (r) => r.abort());
  let uploads = 0;
  await page.route("https://api.openai.com/v1/audio/transcriptions", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    uploads++;
    await route.fulfill({
      headers: cors,
      json: {
        text: WORDS.map((w) => w[0]).join(" "),
        language: "english",
        duration: 3,
        words: WORDS.map(([word, start, end]) => ({ word, start, end })),
      },
    });
  });

  await page.goto("./#/record");
  await page.getByLabel("Name").fill("Talking take");
  await page.getByLabel("Camera", { exact: true }).selectOption("none");
  await page.getByLabel("Microphone", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3200);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await expect(page.getByLabel("Title")).toHaveValue("Talking take", { timeout: 20_000 });

  // Your own key, for the provider's speech-to-text model
  await page.locator(".tr-settings summary").click();
  await page.getByRole("button", { name: "AI settings" }).click();
  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("API key").fill("sk-test");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByLabel("Transcribe with").selectOption("provider");
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  await expect(page.locator(".w")).toHaveCount(WORDS.length, { timeout: 15_000 });
  expect(uploads).toBe(1);

  const before = await length(page);

  // One click removes the filler
  await page.getByRole("button", { name: /Remove 1 filler word/ }).click();
  await expect(page.locator(".w.is-cut")).toHaveText(["um, "]);

  // Select "this is" and delete it
  await page.locator(".w", { hasText: "this" }).evaluate((first) => {
    const last = first.nextElementSibling as Element;
    const range = document.createRange();
    range.setStart(first.firstChild as Node, 0);
    range.setEnd(last.firstChild as Node, 1);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await page.keyboard.press("Delete");
  await expect(page.locator(".w.is-cut")).toHaveCount(3);
  await expect.poll(() => length(page)).toBeLessThanOrEqual(before);

  // Click a struck-out word to bring it back
  await page.locator(".w.is-cut", { hasText: "is" }).first().click();
  await expect(page.locator(".w.is-cut")).toHaveCount(1);

  // Clicking a kept word moves the playhead there
  await page.locator(".w", { hasText: "dashboard" }).click();
  await expect(page.locator(".tc")).not.toHaveText(/^0:00 \/ 0:00/);

  // A word the model got wrong is corrected in place
  await page.locator(".w", { hasText: "dashboard" }).dblclick();
  await page.getByLabel("Correct the word").fill("homepage.");
  await page.keyboard.press("Enter");
  await expect(page.locator(".w").last()).toHaveText("homepage. ");

  // The voice was only for the transcript: muted, its text stays
  const take = page.getByRole("region", { name: "Take 1" });
  await take.getByRole("button", { name: "Muted" }).click();
  await expect(take.getByRole("button", { name: "Muted" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".w")).toHaveCount(WORDS.length);
  expect(errors).toEqual([]);
});

test("a take with no voice gets its text typed, then is cut by it", async ({ page, context }) => {
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/models\.dev|openrouter\.ai/, (r) => r.abort());

  await page.goto("./#/record");
  await page.getByLabel("Name").fill("Silent take");
  await page.getByLabel("Camera", { exact: true }).selectOption("none");
  await page.getByLabel("Microphone", { exact: true }).selectOption("none");
  await page.getByLabel("With the tab's or system's sound").uncheck();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3200);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await expect(page.getByLabel("Title")).toHaveValue("Silent take", { timeout: 20_000 });

  const take = page.getByRole("region", { name: "Take 1" });
  await expect(take.getByRole("button", { name: "Transcribe", exact: true })).toBeDisabled();
  await take.getByRole("button", { name: "Write the text" }).click();
  await take.getByLabel("Text of take 1").fill("Here is the dashboard. And here are the people.");
  await take.getByRole("button", { name: "Save the text" }).click();
  await expect(page.locator(".w")).toHaveCount(9);
  await expect(take.getByText("Typed: times are estimated")).toBeVisible();

  const before = await length(page);
  await page.locator(".w", { hasText: "And" }).evaluate((first) => {
    const last = first.parentElement?.lastElementChild as Element;
    const range = document.createRange();
    range.setStart(first.firstChild as Node, 0);
    range.setEnd(last.firstChild as Node, 1);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await page.keyboard.press("Delete");
  await expect(page.locator(".w.is-cut")).toHaveCount(5);
  await expect.poll(() => length(page)).toBeLessThan(before);
  expect(errors).toEqual([]);
});

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
