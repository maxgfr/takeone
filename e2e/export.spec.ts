import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

async function recordTake(page: Page, title: string) {
  await page.goto("./#/record");
  await page.getByLabel("Name").fill(title);
  await page.getByLabel("Camera", { exact: true }).selectOption("");
  await page.getByLabel("Microphone", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await expect(page.getByLabel("Title")).toHaveValue(title, { timeout: 20_000 });
}

/** Duration and size of a video file, read by the browser. */
async function probe(page: Page, bytes: Buffer, type: string) {
  return page.evaluate(
    async ({ data, type }) => {
      const v = document.createElement("video");
      v.muted = true;
      v.src = URL.createObjectURL(new Blob([new Uint8Array(data)], { type }));
      await new Promise((r, j) => {
        v.onloadedmetadata = r;
        v.onerror = j;
      });
      return { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
    },
    { data: Array.from(bytes), type },
  );
}

test("the edit exports to MP4 (with its sound), a vertical version, HTML, GIF and text", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await recordTake(page, "Export me");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export and share" });

  // MP4, 720p, as edited
  await dialog.getByLabel("Resolution").selectOption("720");
  let download = page.waitForEvent("download", { timeout: 90_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  let file = await readFile(await (await download).path());
  expect(file.includes("ftyp")).toBe(true);
  // An audio track: AAC where the browser encodes it, else Opus (open-source Chromium on Linux)
  expect(file.includes("mp4a") || file.includes("Opus")).toBe(true);
  const mp4 = await probe(page, file, "video/mp4");
  expect([mp4.w, mp4.h]).toEqual([1280, 720]);
  expect(mp4.duration).toBeGreaterThan(2);

  // The same, vertical
  await dialog.getByLabel("Shape").selectOption("9:16");
  download = page.waitForEvent("download", { timeout: 90_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  file = await readFile(await (await download).path());
  const vertical = await probe(page, file, "video/mp4");
  expect([vertical.w, vertical.h]).toEqual([720, 1280]);

  // One HTML page that plays offline
  await dialog.getByLabel("Shape").selectOption("project");
  await dialog.getByRole("button", { name: /HTML page/ }).click();
  download = page.waitForEvent("download", { timeout: 90_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const html = await readFile(await (await download).path(), "utf8");
  expect(html).toContain('id="takeone-data"');
  const offline = await context.newPage();
  await offline.setContent(html);
  await expect(offline.getByRole("heading", { name: "Export me" })).toBeVisible();
  await offline.getByRole("button", { name: "Play" }).first().click();
  await expect(offline.locator(".tp-time")).not.toHaveText(/^0:00 \/ 0:00$/);

  // GIF and transcript
  await dialog.getByRole("button", { name: /GIF/ }).click();
  download = page.waitForEvent("download", { timeout: 90_000 });
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  file = await readFile(await (await download).path());
  expect(file.subarray(0, 6).toString()).toBe("GIF89a");
  await dialog.getByRole("button", { name: /Transcript/ }).click();
  download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  expect(await readFile(await (await download).path(), "utf8")).toContain("# Export me");

  // The last video can be shared live from here
  await expect(dialog.getByRole("button", { name: "Share the last video live" })).toBeVisible();
  expect(errors).toEqual([]);
});
