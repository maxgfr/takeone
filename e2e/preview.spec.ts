import { expect, test } from "@playwright/test";

test("the preview plays through cuts without an empty frame", async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./#/record");
  await page.getByLabel("Camera", { exact: true }).selectOption("");
  await page.getByLabel("Microphone", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(8200);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await expect(page.locator(".tr-take")).toHaveCount(1, { timeout: 20_000 });

  // Two cuts, dragged across the video row
  const row = page.locator(".tl-video");
  const box = await row.boundingBox();
  if (!box) throw new Error("no video row");
  for (const [a, b] of [
    [0.25, 0.35],
    [0.55, 0.62],
  ] as const) {
    await page.mouse.move(box.x + box.width * a, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * b, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Cut", exact: true }).click();
  }
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.locator(".tc")).toHaveText(/^0:00 /);
  await page.waitForTimeout(800);

  // Every frame while it plays: the fake screen (green) is on the canvas, never the bare background.
  const empty = await page.evaluate(async () => {
    const c = document.querySelector<HTMLCanvasElement>(".stage-canvas");
    const ctx = c?.getContext("2d", { willReadFrequently: true });
    if (!c || !ctx) return -1;
    document.querySelector<HTMLButtonElement>('button[aria-label="Play"]')?.click();
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 6000) {
      await new Promise((r) => requestAnimationFrame(r));
      const [r = 0, g = 0] = ctx.getImageData(
        Math.round(c.width * 0.3),
        Math.round(c.height * 0.5),
        1,
        1,
      ).data;
      if (!(g > 100 && r < 120)) n++;
    }
    return n;
  });
  expect(empty).toBe(0);
  expect(errors).toEqual([]);
});
