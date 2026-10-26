import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

/** What the mocked speech-to-text model hears: the take first, then the voice-over. */
const TAKE = [
  ["So", 0.2, 0.4],
  ["this", 0.5, 0.7],
  ["is", 0.75, 0.9],
  ["it.", 0.95, 1.2],
] as const;
const OVER = [
  ["Welcome", 0.3, 0.7],
  ["to", 0.75, 0.9],
  ["the", 0.95, 1.1],
  ["dashboard.", 1.15, 1.8],
] as const;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

test("a voice-over recorded over the edit is heard and becomes the text", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/models\.dev|openrouter\.ai/, (r) => r.abort());
  let uploads = 0;
  await page.route("https://api.openai.com/v1/audio/transcriptions", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    const words = uploads++ === 0 ? TAKE : OVER;
    await route.fulfill({
      headers: cors,
      json: {
        text: words.map((w) => w[0]).join(" "),
        language: "english",
        duration: 3,
        words: words.map(([word, start, end]) => ({ word, start, end })),
      },
    });
  });

  // A take whose voice is only there for the transcript
  await page.goto("./#/record");
  await page.getByLabel("Name").fill("Dubbed take");
  await page.getByLabel("Camera", { exact: true }).selectOption("none");
  await page.getByLabel("Microphone", { exact: true }).selectOption("");
  await page.getByLabel(/Only for the transcript/).check();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3200);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await expect(page.getByLabel("Title")).toHaveValue("Dubbed take", { timeout: 20_000 });
  const take = page.getByRole("region", { name: "Take 1" });
  await expect(take.getByRole("button", { name: "Muted" })).toHaveAttribute("aria-pressed", "true");

  await page.locator(".tr-settings summary").click();
  await page.getByRole("button", { name: "AI settings" }).click();
  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("API key").fill("sk-test");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByLabel("Transcribe with").selectOption("provider");
  await take.getByRole("button", { name: "Transcribe", exact: true }).click();
  await expect(page.locator(".w")).toHaveText(["So ", "this ", "is ", "it. "], { timeout: 15_000 });

  // The voice-over: the whole edit plays, then it is transcribed and heard
  await page.getByRole("button", { name: "Record voice-over" }).click();
  await expect(page.getByRole("button", { name: /Stop voice-over/ })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Record voice-over" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(".w")).toHaveText(["Welcome ", "to ", "the ", "dashboard. "], {
    timeout: 15_000,
  });
  expect(uploads).toBe(2);
  await expect(take.getByRole("button", { name: "Voice-over", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(take.getByText("Text of the voice-over")).toBeVisible();

  // The take's own text comes back with its voice, and goes again with the voice-over
  await take.getByRole("button", { name: "Take's voice" }).click();
  await expect(page.locator(".w").first()).toHaveText("So ");
  await take.getByRole("button", { name: "Voice-over", exact: true }).click();
  await expect(page.locator(".w").first()).toHaveText("Welcome ");

  // The sound alone is the voice-over's
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export and share" });
  await dialog.getByRole("button", { name: /Sound only/ }).click();
  const download = page.waitForEvent("download", { timeout: 90_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const file = await readFile(await (await download).path());
  expect(file.length).toBeGreaterThan(1000);

  // Removing the voice-over leaves the take muted, with its text
  await page.keyboard.press("Escape");
  await take.getByRole("button", { name: "Remove the voice-over" }).click();
  await expect(take.getByRole("button", { name: "Voice-over", exact: true })).toHaveCount(0);
  await expect(page.locator(".w").first()).toHaveText("So ");
  expect(errors).toEqual([]);
});
