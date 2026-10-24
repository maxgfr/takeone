/**
 * Peer-to-peer share links, end to end: one browser context hosts a freshly
 * recorded webm through the LivePanel, another opens the link, receives the
 * file byte for byte, watches it, names itself and reacts, and the host's
 * table shows all of it. Signaling goes through the local relay and tracker
 * of test/serve.ts, and ICE uses no STUN: nothing leaves this machine.
 */
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

async function context(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const host = location.host;
    localStorage.setItem(
      "takeone.p2p.v1",
      JSON.stringify({
        relays: [`ws://${host}/relay`],
        trackers: [`ws://${host}/tracker`],
        stun: [],
      }),
    );
  });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Uncaught/i.test(m.text()))
      errors.push(m.text());
  });
  return errors;
}

test("a viewer streams the video from the author's tab, and the author sees them live", async ({
  browser,
}) => {
  const hostCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  await context(hostCtx);
  await context(viewerCtx);

  const host = await hostCtx.newPage();
  const hostErrors = watchErrors(host);
  await host.goto("./");
  await host.addScriptTag({ url: "./__e2e/live-host.js", type: "module" });
  const linkInput = host.getByTestId("live-link");
  await expect(linkInput).toHaveValue(/#\/watch\/[A-Za-z0-9_-]{58}$/, { timeout: 20_000 });
  await expect(host.getByTestId("live-state")).toContainText("Live");
  const link = await linkInput.inputValue();
  const sent = await host.evaluate(() => window.__e2e);
  expect(sent?.size).toBeGreaterThan(10_000);

  const viewer = await viewerCtx.newPage();
  const viewerErrors = watchErrors(viewer);
  await viewer.goto(link);
  const video = viewer.getByTestId("watch-video");
  await expect(video).toBeVisible({ timeout: 30_000 });
  await expect(viewer.getByRole("heading", { name: "E2E demo" })).toBeVisible();

  // Byte for byte.
  const received = await viewer.evaluate(async () => {
    const v = document.querySelector("video");
    if (!v) return null;
    const buf = await (await fetch(v.src)).arrayBuffer();
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return {
      size: buf.byteLength,
      digest: Array.from(d, (b) => b.toString(16).padStart(2, "0")).join(""),
    };
  });
  expect(received).toEqual({ size: sent?.size, digest: sent?.digest });

  // The host sees an unnamed viewer who has the whole file.
  const rows = host.getByTestId("viewer-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Viewer 1");

  // Name, reaction, then watch it to the end.
  await viewer.getByTestId("watch-name").fill("Ada");
  await viewer.getByTestId("watch-name").press("Tab");
  await viewer.getByRole("button", { name: "Thumbs up" }).click();
  await expect(viewer.getByText("Sent to the author.")).toBeVisible();
  await viewer.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) throw new Error("no video");
    v.muted = true;
    return v.play();
  });
  await viewer.waitForFunction(() => document.querySelector("video")?.ended === true, null, {
    timeout: 15_000,
  });

  const row = rows.filter({ hasText: "Ada" });
  await expect(row).toContainText("👍");
  await expect(row).toContainText("Paused at");
  await expect(row.locator(".reach")).not.toHaveAttribute("aria-label", /^Reached 0:00/);
  await expect(row.locator("td").nth(2)).not.toHaveText("0:00");
  await expect(host.getByTestId("live-state")).toContainText("1 watching");

  // The viewer leaves: the host keeps the row, marked as gone, with where they stopped.
  await viewer.close();
  await expect(row).toContainText("Left at", { timeout: 15_000 });
  await expect(host.getByTestId("live-state")).toContainText("0 watching");

  expect(hostErrors).toEqual([]);
  expect(viewerErrors).toEqual([]);
  await hostCtx.close();
  await viewerCtx.close();
});

test("a broken link explains itself", async ({ page }) => {
  await page.goto("./#/watch/not-a-real-token");
  await expect(page.getByRole("alert")).toContainText("This link is not valid");
});
