/**
 * End-to-end fixture, served by test/serve.ts at /takeone/__e2e/live-host.js
 * (same origin, so the page's CSP allows it): records a short webm from a
 * canvas, then opens the LivePanel on it, the way the editor's Share menu
 * will. The file's SHA-256 is left on `window.__e2e` for the test to compare.
 */
import { render } from "preact";
import { LivePanel } from "../../src/app/LivePanel";

declare global {
  interface Window {
    __e2e?: { digest: string; size: number; closed: boolean };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recordWebm(ms: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  let frame = 0;
  const draw = () => {
    ctx.fillStyle = `hsl(${(frame * 9) % 360} 70% 50%)`;
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#fff";
    ctx.font = "48px sans-serif";
    ctx.fillText(String(frame++), 24, 100);
  };
  draw();
  const timer = setInterval(draw, 33);
  const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  const stopped = new Promise((r) => {
    rec.onstop = r;
  });
  rec.start(250);
  await sleep(ms);
  rec.stop();
  await stopped;
  clearInterval(timer);
  return new Blob(parts, { type: "video/webm" });
}

async function sha256(blob: Blob): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

const blob = await recordWebm(2000);
window.__e2e = { digest: await sha256(blob), size: blob.size, closed: false };
const root = document.createElement("div");
root.id = "e2e-live";
document.body.append(root);
render(
  <LivePanel
    file={blob}
    meta={{ title: "E2E demo", duration: 2, type: "video/webm", size: blob.size }}
    onClose={() => {
      render(null, root);
      if (window.__e2e) window.__e2e.closed = true;
    }}
  />,
  root,
);
