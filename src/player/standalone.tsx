/**
 * The player inside an exported HTML file: the video travels in the page as
 * base64 (one file, plays offline), with its words, chapters and captions.
 */
import { render } from "preact";
import { Player, type PlayerData } from "./Player";

interface Payload extends Omit<PlayerData, "src"> {
  type: string;
  video: string;
}

function fromBase64(b64: string): Uint8Array {
  const native = (Uint8Array as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (native) return native(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const raw = document.getElementById("takeone-data")?.textContent;
const root = document.getElementById("takeone");
if (raw && root) {
  const payload = JSON.parse(raw) as Payload;
  const { video, type, ...rest } = payload;
  const src = URL.createObjectURL(new Blob([fromBase64(video) as BlobPart], { type }));
  render(<Player data={{ ...rest, src }} />, root);
}
