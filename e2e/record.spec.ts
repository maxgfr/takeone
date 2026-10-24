import { expect, type Page, test } from "@playwright/test";

async function recordTake(page: Page, title: string, seconds = 2.5) {
  await page.goto("./#/record");
  await page.getByLabel("Name").fill(title);
  await page.getByLabel("Camera", { exact: true }).selectOption("");
  await page.getByLabel("Microphone", { exact: true }).selectOption("");
  await expect(page.getByLabel("Camera preview")).toBeVisible();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(seconds * 500);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Paused")).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await page.waitForTimeout(seconds * 500);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await expect(page.getByLabel("Title")).toHaveValue(title, { timeout: 20_000 });
}

/** Seconds of the edit, read from the time code ("0:01 / 0:03"). */
async function length(page: Page): Promise<number> {
  const text = (await page.locator(".tc").textContent()) ?? "";
  const [m = "0", s = "0"] = (text.split("/")[1] ?? "").trim().split(":");
  return Number(m) * 60 + Number(s);
}

test("a take is recorded, then edited: preview, play, cut, zoom, layout, undo", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await recordTake(page, "First take", 3);

  // The preview draws the take on its background
  const canvas = page.getByLabel("Preview");
  await expect(canvas).toBeVisible();
  await expect
    .poll(
      () =>
        canvas.evaluate((c: HTMLCanvasElement) => {
          const ctx = c.getContext("2d");
          if (!ctx || !c.width) return 0;
          const { data } = ctx.getImageData(c.width / 2, c.height / 2, 1, 1);
          return (data[0] ?? 0) + (data[1] ?? 0) + (data[2] ?? 0);
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  const before = await length(page);
  expect(before).toBeGreaterThanOrEqual(2);

  // Play: the time moves
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.locator(".tc")).not.toHaveText(/^0:00 /, { timeout: 5000 });
  await page.getByRole("button", { name: "Pause" }).click();

  // Select the first second on the video row and cut it
  const track = page.getByRole("slider", { name: "Position in the video" });
  const box = await track.boundingBox();
  if (!box) throw new Error("no timeline");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Cut", exact: true }).click();
  await expect.poll(() => length(page)).toBeLessThan(before);
  await expect(page.locator(".tl-join, .tl-seg")).not.toHaveCount(0);

  // Zoom from the playhead: the region shows on the preview, the block on the timeline
  await page.getByRole("button", { name: "Zoom", exact: true }).click();
  await expect(page.locator(".region-zoom")).toBeVisible();
  await expect(page.locator(".tl-zoom").first()).toBeVisible();

  // A layout for the next two seconds
  await page.getByLabel("Layout of the selection").selectOption("camera");
  await expect(page.locator(".tl-layout")).toHaveCount(1);

  // Undo the layout
  await page.keyboard.press("Escape");
  await page.locator("body").press("Meta+z");
  await expect(page.locator(".tl-layout")).toHaveCount(0);

  // The project is listed on the home page
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByRole("button", { name: /^First take/ })).toBeVisible();
  expect(errors).toEqual([]);
});
