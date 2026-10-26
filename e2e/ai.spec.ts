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
  ask: {
    reply: "I cut the false start and fixed a word.",
    cut: [{ take: 1, from: 0, to: 3, why: "restarted sentence" }],
    restore: [],
    fix: [{ take: 1, word: 8, text: "homepage." }],
    zooms: [],
    layouts: [],
    blurs: [],
    chapters: [{ take: 1, word: 4, title: "Intro" }],
  },
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
  texts: { title: "The dashboard", summary: "A tour.", description: "How to add people." },
  posts: { linkedin: "New video [link]", x: "Watch [link]", youtube: "A tour." },
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
  await page.locator(".tr-settings summary").click();
  await page.getByRole("button", { name: "AI settings" }).click();
  await page.getByLabel("Provider").selectOption("openai");
  await page.getByLabel("API key").fill("sk-test");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByLabel("Transcribe with").selectOption("provider");
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  await expect(page.locator(".w")).toHaveCount(WORDS.length, { timeout: 15_000 });
  return { asked, images };
}

test("asked in plain words, the AI cuts, corrects and adds chapters; then the texts", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { asked } = await transcribedTake(page, "AI take");

  // A request in plain words: one answer, its changes listed
  await page.getByRole("button", { name: "AI", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "AI" });
  await expect(panel.getByText(/OpenAI/)).toBeVisible();
  await expect(panel.getByText(/Works from the transcript: 1 take, 13 words/)).toBeVisible();
  await panel.getByLabel("Show it the screen").uncheck();
  await panel
    .getByLabel("Ask the AI")
    .fill("Coupe le faux départ, corrige le texte, ajoute des chapitres");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("I cut the false start and fixed a word.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(panel.locator(".ai-req")).toHaveText(
    "Coupe le faux départ, corrige le texte, ajoute des chapitres",
  );
  await expect(panel.getByLabel("Ask the AI")).toHaveValue("");
  const changes = panel.getByRole("list", { name: "Changes" });
  const retake = changes.getByRole("listitem").filter({ hasText: "Cut “So this is the—”" });
  await expect(retake).toContainText("restarted sentence");
  await expect(page.locator(".w.is-cut")).toHaveCount(4);
  const fix = changes.getByRole("listitem").filter({ hasText: "1 word corrected" });
  await expect(fix).toContainText("dashboard. → homepage.");
  await expect(page.locator(".w", { hasText: "homepage." })).toHaveCount(1);
  expect(asked).toEqual(["ask"]);

  // Chapters: on the timeline, and listed for YouTube
  await expect(page.locator(".tl-chapter")).toHaveText(["Intro"]);
  await expect(panel.locator(".ai-pre")).toHaveText("0:00 Intro");
  await panel.getByLabel("Title of chapter 1").fill("Welcome");
  await expect(page.locator(".tl-chapter")).toHaveText(["Welcome"]);

  // Dropping a change undoes just it: the word, then the cut
  await fix.getByRole("button", { name: /^Drop/ }).click();
  await expect(page.locator(".w", { hasText: "dashboard." })).toHaveCount(1);
  await retake.getByRole("button", { name: /^Drop/ }).click();
  await expect(page.locator(".w.is-cut")).toHaveCount(0);

  // Texts: the title, the summary, then the posts written from them
  await panel.getByRole("button", { name: "Texts", exact: true }).click();
  await panel.getByRole("button", { name: "Write title, summary and posts" }).click();
  await expect(panel.getByLabel("Summary")).toHaveValue("A tour.");
  await expect(panel.getByLabel("LinkedIn")).toHaveValue("New video [link]");
  await expect(page.getByLabel("Title").first()).toHaveValue("The dashboard");
  expect(asked.slice(1)).toEqual(["texts", "posts"]);
  await panel.getByRole("button", { name: "Close the AI panel" }).click();
  await page.locator(".w", { hasText: "the—" }).evaluate((first) => {
    // Cut the retake again by its words, for the captions below.
    const last = first.previousElementSibling?.previousElementSibling?.previousElementSibling;
    const range = document.createRange();
    range.setStart((last ?? first).firstChild as Node, 0);
    range.setEnd(first.firstChild as Node, 1);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await page.keyboard.press("Delete");
  await expect(page.locator(".w.is-cut")).toHaveCount(4);

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
  await panel.getByRole("button", { name: "Full edit" }).click();
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
