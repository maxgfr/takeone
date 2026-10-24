import { expect, test } from "@playwright/test";

test("home renders without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /Record once/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start recording" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the page is isolated, so speech to text can use several threads", async ({ page }) => {
  await page.goto("./");
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test("on a host that sends no headers, the service worker isolates the page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/bare/takeone/");
  // It reloads once when the worker takes over.
  await expect
    .poll(() => page.evaluate(() => crossOriginIsolated).catch(() => false), { timeout: 10_000 })
    .toBe(true);
  await expect(page.getByRole("heading", { name: /Record once/ })).toBeVisible();
  // A worker of the page is isolated too: onnxruntime gets its threads.
  const workerIsolated = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const w = new Worker(
          URL.createObjectURL(new Blob(["postMessage(self.crossOriginIsolated)"])),
        );
        w.onmessage = (e) => resolve(e.data === true);
        w.onerror = () => resolve(false);
      }),
  );
  expect(workerIsolated).toBe(true);
  expect(errors).toEqual([]);
});
