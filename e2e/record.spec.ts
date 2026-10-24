import { expect, test } from "@playwright/test";

test("a take records the screen, the camera and the microphone into their own files", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["camera", "microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("./#/record");
  await page.getByLabel("Name").fill("First take");
  await page.getByLabel("Camera", { exact: true }).selectOption("");
  await page.getByLabel("Microphone", { exact: true }).selectOption("");
  await expect(page.getByLabel("Camera preview")).toBeVisible();
  await page.getByLabel("Teleprompter").check();
  await page.getByLabel("Script").fill("Hello and welcome. Today I will show you the dashboard.");
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText("Recording", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Paused")).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /Stop/ }).first().click();

  await expect(page.getByRole("heading", { name: "First take" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Take 1/ })).toBeVisible();
  for (const label of ["Screen", "Camera"]) await expect(page.getByLabel(label)).toBeVisible();
  await expect(page.getByLabel("Microphone")).toBeAttached();
  // The screen file plays: it has a duration
  const duration = await page.getByLabel("Screen").evaluate(
    (v: HTMLVideoElement) =>
      new Promise<number>((resolve) => {
        if (v.readyState >= 1) resolve(v.duration);
        else v.onloadedmetadata = () => resolve(v.duration);
      }),
  );
  expect(duration).toBeGreaterThan(0);

  await page.goto("./#/");
  await expect(page.getByRole("button", { name: /^First take/ })).toBeVisible();
  expect(errors).toEqual([]);
});
