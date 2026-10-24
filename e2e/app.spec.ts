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
