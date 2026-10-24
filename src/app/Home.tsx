import { navigate } from "./router";
import { Button, Icon, type IconName } from "./ui";

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "record",
    title: "Every source on its own track",
    body: "Screen, camera, microphone and system sound are recorded separately, so the layout, the camera's size and the sound can all change after the take.",
  },
  {
    icon: "text",
    title: "Edit the video like a document",
    body: "Your words, timed to the word. Delete a sentence and the video loses it; filler words and long pauses go in one click.",
  },
  {
    icon: "wand",
    title: "Looks finished by default",
    body: "Backgrounds, rounded corners, zooms that follow your clicks, a camera bubble, captions in your style, noise removed and the voice levelled.",
  },
  {
    icon: "sparkles",
    title: "Your AI, or none at all",
    body: "Bring your own key for titles, chapters and one-click clean-ups, or transcribe with Whisper right on this device.",
  },
  {
    icon: "share",
    title: "Share without uploading",
    body: "Send a link that streams from your tab, and see who watches and where they stop. Or export MP4, 4K, vertical, GIF or one HTML file.",
  },
  {
    icon: "check",
    title: "No account, no subscription",
    body: "takeone is a web page: your recordings stay in your browser's storage, on this device.",
  },
];

export function Home() {
  return (
    <main class="home">
      <section class="hero">
        <p class="eyebrow">
          <span class="rec" aria-hidden="true" /> Free, open source, nothing uploaded
        </p>
        <h1>
          Record once.
          <br />
          Edit by text.
          <br />
          Share without a server.
        </h1>
        <p class="lede">
          takeone records your screen, camera and voice, then lets you edit the video by editing its
          transcript. Everything happens in your browser.
        </p>
        <div class="hero-actions">
          <Button variant="primary" size="lg" icon="record" onClick={() => navigate("#/record")}>
            Start recording
          </Button>
        </div>
      </section>

      <section class="mock" aria-label="What editing looks like">
        <div class="mock-video">
          <div class="mock-screen" />
          <div class="mock-cam" />
        </div>
        <p class="mock-text">
          So this is the dashboard. <s>Um,</s> you open the reports tab here, <s>and, uh,</s> pick
          the week you want. <s>Wait, let me redo that.</s> Pick the week, and export it as a PDF.
        </p>
      </section>

      <section class="features" aria-label="Features">
        {FEATURES.map((f) => (
          <article key={f.title} class="feature">
            <Icon name={f.icon} size={20} />
            <h2>{f.title}</h2>
            <p>{f.body}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
