import { expect, type Page, type Route, test } from "@playwright/test";

/** What the mocked speech-to-text model hears: a sentence restarted, then a second one. */
const WORDS = [
  ["So", 0.1, 0.25],
  ["this", 0.3, 0.45],
  ["is", 0.5, 0.6],
  ["the—", 0.65, 0.8],
  ["so", 0.9, 1.0],
  ["this", 1.05, 1.2],
  ["is", 1.25, 1.35],
  ["the", 1.4, 1.5],
  ["dashboard.", 1.55, 2.0],
  ["Here", 2.2, 2.35],
  ["you", 2.4, 2.5],
  ["add", 2.55, 2.7],
  ["people.", 2.75, 3.0],
] as const;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

/** What the mocked model answers, by the name of the schema it is asked to fill. */
const ANSWERS: Record<string, unknown> = {
  retakes: { retakes: [{ take: 1, from: 0, to: 3, reason: "restarted sentence" }] },
  edit: {
    zooms: [
      {
        take: 1,
        from: 9,
        to: 12,
        region: { x: 0.6, y: 0.1, w: 0.2, h: 0.1 },
        why: "the add button",
      },
    ],
    layouts: [],
    blurs: [{ frame: "F1", region: { x: 0.1, y: 0.8, w: 0.3, h: 0.05 }, why: "an email address" }],
  },
  chapters: {
    chapters: [
      { take: 1, word: 4, title: "Intro" },
      { take: 1, word: 99, title: "Out of range" },
    ],
  },
};

/** OpenAI's Responses API, as the AI SDK reads it; `images` counts the images each call sent. */
async function responses(route: Route, asked: string[], images: Record<string, number> = {}) {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const body = route.request().postDataJSON() as {
    text?: { format?: { name?: string } };
    input?: { content?: { type: string }[] | string }[];
  };
  const name = body.text?.format?.name ?? "";
  asked.push(name);
  images[name] = (body.input ?? []).flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((c) => c.type === "input_image") : [],
  ).length;
  await route.fulfill({
    headers: cors,
    json: {
      id: `resp_${name}`,
      object: "response",
      created_at: 1_700_000_000,
      status: "completed",
      model: "gpt-test",
      output: [
        {
          type: "message",
          id: `msg_${name}`,
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: JSON.stringify(ANSWERS[name] ?? {}), annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  });
}

/** Near-black pixels at the bottom of the preview, where the captions' band goes (counted in the page). */
function darkBottom(page: Page): Promise<number> {
  return page.locator(".stage-canvas").evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const top = Math.round(c.height * 0.72);
    const { data } = ctx.getImageData(0, top, c.width, c.height - top);
    let n = 0;
    for (let i = 0; i < data.length; i += 4)
      if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) < 90) n++;
    return n;
  });
}

/** The dark-pixel count once the paused preview has settled (two reads in a row agree). */
async function steadyDark(page: Page): Promise<number> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const now = await darkBottom(page);
    if (Math.abs(now - last) < 50) return now;
    last = now;
    await page.waitForTimeout(150);
  }
  return last;
}

/** A take recorded and transcribed with a mocked OpenAI key; what the model is then asked. */
async function transcribedTake(
  page: Page,
  name: string,
): Promise<{ asked: string[]; images: Record<string, number> }> {
  await page.route(/models\.dev|openrouter\.ai/, (r) => r.abort());
  await page.route("https://api.openai.com/v1/audio/transcriptions", async (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors });
    await route.fulfill({
      headers: cors,
      json: {
        text: WORDS.map((w) => w[0]).join(" "),
        language: "english",
        duration: 3.2,
        words: WORDS.map(([word, start, end]) => ({ word, start, end })),
      },
    });
  });
  const asked: string[] = [];
  const images: Record<string, number> = {};
  await page.route("https://api.openai.com/v1/responses", (route) =>
    responses(route, asked, images),
  );

  // A take, transcribed with your own key
  await page.goto("./#/record");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Camera", { exact: true }).selectOption("none");
  await page.getByLabel("Microphone", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3400);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await expect(page.getByLabel("Title")).toHaveValue(name, { timeout: 20_000 });
  await page.getByRole("button", { name: "AI settings" }).click();
  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("API key").fill("sk-test");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByLabel("Transcribe with").selectOption("provider");
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  await expect(page.locator(".w")).toHaveCount(WORDS.length, { timeout: 15_000 });
  return { asked, images };
}

test("the AI cuts a retake and finds chapters; captions show on the preview", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { asked } = await transcribedTake(page, "AI take");

  // Retakes: found, played, accepted as a cut
  await page.getByRole("button", { name: "AI", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "AI" });
  await expect(panel.getByText(/OpenAI/)).toBeVisible();
  await panel.getByRole("button", { name: "Retakes", exact: true }).click();
  await panel.getByRole("button", { name: "Find retakes" }).click();
  const retake = panel.getByRole("listitem").filter({ hasText: "So this is the—" });
  await expect(retake).toBeVisible();
  await expect(retake).toContainText("restarted sentence");
  await retake.getByRole("button", { name: "Accept: cut it" }).click();
  await expect(page.locator(".w.is-cut")).toHaveCount(4);
  await expect(retake.getByRole("button", { name: "Restore" })).toBeVisible();

  // Chapters: on the timeline, and listed for YouTube
  await panel.getByRole("button", { name: "Chapters", exact: true }).click();
  await panel.getByRole("button", { name: "Find chapters" }).click();
  await expect(page.locator(".tl-chapter")).toHaveText(["Intro"]);
  await expect(panel.locator(".ai-pre")).toHaveText("0:00 Intro");
  await panel.getByLabel("Title of chapter 1").fill("Welcome");
  await expect(page.locator(".tl-chapter")).toHaveText(["Welcome"]);
  expect(asked).toEqual(["retakes", "chapters"]);
  await panel.getByRole("button", { name: "Close the AI panel" }).click();

  // Captions: their dark band shows at the bottom of the preview while a sentence is said.
  // One second in (the retake is cut), "so this is the dashboard." is being said.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".tc")).toHaveText(/^0:01 /);
  const off = await steadyDark(page);
  await page.getByLabel("Show captions").check();
  await expect.poll(async () => (await darkBottom(page)) - off).toBeGreaterThan(3000);
  await page.getByLabel("Show captions").uncheck();
  await expect.poll(async () => Math.abs((await darkBottom(page)) - off)).toBeLessThan(800);
  expect(errors).toEqual([]);
});

test("the AI edits the video: zooms, blurs, cuts and chapters in one step", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { asked, images } = await transcribedTake(page, "Edited take");

  await page.getByRole("button", { name: "AI", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "AI" });
  await panel.getByRole("button", { name: "Edit the video" }).click();
  const changes = panel.getByRole("list", { name: "Changes" });
  await expect(changes).toBeVisible({ timeout: 20_000 });
  await expect(changes.getByRole("listitem").filter({ hasText: /^.*Zoom 2\.4×/ })).toContainText(
    "the add button",
  );
  await expect(changes.getByRole("listitem").filter({ hasText: "Blur" })).toContainText(
    "an email address",
  );
  await expect(changes.getByText("Cut “So this is the—”")).toBeVisible();
  await expect(changes.getByText("Chapter: Intro")).toBeVisible();
  // The model saw stills of the screen; the retakes and chapters calls read words only.
  expect([...asked].sort()).toEqual(["chapters", "edit", "retakes"]);
  expect(images.edit).toBeGreaterThan(0);
  expect(images.retakes).toBe(0);
  await expect(page.locator(".w.is-cut")).toHaveCount(4);
  await expect(page.locator(".tl-chapter")).toHaveText(["Intro"]);

  // A change dropped is gone from the edit; undo brings it back.
  await changes.getByRole("button", { name: "Drop: Blur" }).click();
  await expect(changes.getByRole("listitem").filter({ hasText: "Blur" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(changes.getByRole("listitem").filter({ hasText: "Blur" })).toHaveCount(1);
  expect(errors).toEqual([]);
});
