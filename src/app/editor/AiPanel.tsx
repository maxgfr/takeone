/**
 * The AI panel, in place of the settings while it is open: retakes to cut
 * (each one played, then accepted or rejected), chapters, a title with a
 * summary and a description, and posts to share the video. Every tool is one
 * request to the user's own model, cancellable, and nothing it writes is
 * final: retakes are ordinary cuts, and every text stays editable.
 */
import { signal, useSignal } from "@preact/signals";
import { type LlmSettings, languageName, RESPONSE_LANGUAGES } from "llm-connect";
import { useEffect } from "preact/hooks";
import { llmState, loadLlmSettings, modelLabel, savedSettings } from "../../ai/settings";
import {
  answerLanguage,
  findChapters,
  findRetakes,
  type Retake,
  retakeCut,
  writePosts,
  writeTexts,
} from "../../ai/tools";
import { chapterList, chapterMarks, chapterTime } from "../../edit/chapters";
import { fillerCuts, silenceCuts } from "../../edit/clean";
import { clipAt } from "../../edit/ops";
import type { PreviewEngine } from "../../edit/preview";
import { newId, type Project } from "../../model/project";
import { ModelSettingsModal } from "../ModelSettings";
import { clock } from "../Record";
import { Button, copyText, errorText, Field, Icon, IconButton, toast } from "../ui";
import { project, segments, update } from "./state";

/** The panel is open. */
export const aiOpen = signal(false);

type Tool = "retakes" | "chapters" | "texts" | "posts";
const TABS: { id: Tool; label: string }[] = [
  { id: "retakes", label: "Retakes" },
  { id: "chapters", label: "Chapters" },
  { id: "texts", label: "Title" },
  { id: "posts", label: "Posts" },
];

const tab = signal<Tool>("retakes");
/** "" writes in the video's language. */
const language = signal("");
const running = signal<Partial<Record<Tool, AbortController>>>({});
const failed = signal<Partial<Record<Tool, string>>>({});

/** Retakes found, for one project, and what became of each: the cut made when accepted. */
const found = signal<{ project: string; items: Retake[] } | null>(null);
const decided = signal<Record<string, { cut: string } | "rejected">>({});

async function run<T>(
  tool: Tool,
  task: (settings: LlmSettings, p: Project, signal: AbortSignal) => Promise<T>,
  done: (result: T) => void,
): Promise<void> {
  await loadLlmSettings();
  const settings = savedSettings();
  const p = project.value;
  if (!settings || !p || running.value[tool]) return;
  const ctrl = new AbortController();
  running.value = { ...running.value, [tool]: ctrl };
  const { [tool]: _, ...errors } = failed.value;
  failed.value = errors;
  try {
    done(await task(settings, p, ctrl.signal));
  } catch (err) {
    if (!ctrl.signal.aborted) failed.value = { ...failed.value, [tool]: errorText(err) };
  } finally {
    const { [tool]: _done, ...rest } = running.value;
    running.value = rest;
  }
}

function cancel(tool: Tool) {
  running.value[tool]?.abort();
}

/** The button that runs a tool, its progress with a cancel button, and its error. */
function RunBar({
  tool,
  label,
  busyLabel,
  disabled,
  onRun,
}: {
  tool: Tool;
  label: string;
  busyLabel: string;
  disabled: boolean;
  onRun: () => void;
}) {
  const busy = !!running.value[tool];
  const error = failed.value[tool];
  return (
    <div class="ai-run">
      {busy ? (
        <div class="ai-busy" role="status">
          <span class="spinner spinner-sm" aria-hidden="true" />
          <span>{busyLabel}</span>
          <Button size="sm" variant="ghost" onClick={() => cancel(tool)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button size="sm" icon="sparkles" class="btn-ai" disabled={disabled} onClick={onRun}>
          {label}
        </Button>
      )}
      {error && (
        <p class="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      icon="copy"
      disabled={!text.trim()}
      onClick={async () =>
        toast((await copyText(text)) ? "Copied." : "Could not copy.", "info", 2000)
      }
    >
      {label}
    </Button>
  );
}

function Retakes({
  p,
  engine,
  ready,
}: {
  p: Project;
  engine: PreviewEngine | null;
  ready: boolean;
}) {
  const items = found.value?.project === p.id ? found.value.items : null;
  const decisions = decided.value;
  const isCut = (r: Retake) => {
    const d = decisions[r.id];
    return typeof d === "object" && p.cuts.some((c) => c.id === d.cut);
  };
  const pending = (items ?? []).filter((r) => !isCut(r) && decisions[r.id] !== "rejected");
  const fillers = p.clips.flatMap((c) => fillerCuts(c, p.cuts));
  const pauses = p.clips.flatMap((c) => silenceCuts(c, p.cuts));
  const segs = segments.value;

  const accept = (r: Retake) => {
    const cut = retakeCut(r);
    update((x) => ({ ...x, cuts: [...x.cuts, cut] }));
    decided.value = { ...decided.value, [r.id]: { cut: cut.id } };
  };
  const reject = (r: Retake) => {
    decided.value = { ...decided.value, [r.id]: "rejected" };
  };
  const reopen = (r: Retake) => {
    const d = decided.value[r.id];
    if (typeof d === "object")
      update((x) => ({ ...x, cuts: x.cuts.filter((c) => c.id !== d.cut) }));
    const { [r.id]: _, ...rest } = decided.value;
    decided.value = rest;
  };
  const play = (r: Retake) => {
    const at = chapterTime(segs, { clip: r.clip, t: r.start });
    if (at === null || !engine) return;
    engine.seek(Math.max(0, at - 0.6));
    engine.play();
  };
  const cleanAll = () => {
    const cuts = pending.map((r) => ({ r, cut: retakeCut(r) }));
    update((x) => ({
      ...x,
      cuts: [...x.cuts, ...cuts.map((c) => c.cut), ...fillers, ...pauses],
    }));
    const next = { ...decided.value };
    for (const { r, cut } of cuts) next[r.id] = { cut: cut.id };
    decided.value = next;
    toast("Cleaned up in one step: undo with ⌘Z.", "success");
  };

  return (
    <>
      <p class="muted small">
        Finds the sentences you restarted or stumbled on, so only the clean attempt stays. Filler
        words and pauses have their own buttons in the transcript.
      </p>
      <RunBar
        tool="retakes"
        label={items ? "Look again" : "Find retakes"}
        busyLabel="Reading the transcript…"
        disabled={!ready}
        onRun={() =>
          void run(
            "retakes",
            (s, x, signal) => findRetakes(s, x, language.value || null, signal),
            (rs) => {
              found.value = { project: p.id, items: rs };
              decided.value = {};
              if (rs.length === 0) toast("No retake found: every sentence was said once.");
            },
          )
        }
      />
      {items && items.length > 0 && (
        <ul class="ai-list" aria-label="Retakes">
          {items.map((r) => {
            const cut = isCut(r);
            const rejected = decisions[r.id] === "rejected";
            const take = p.clips.findIndex((c) => c.id === r.clip) + 1;
            const at = chapterTime(segs, { clip: r.clip, t: r.start });
            return (
              <li
                key={r.id}
                class={`ai-item ai-retake${cut ? " is-cut" : ""}${rejected ? " is-rejected" : ""}`}
              >
                <button
                  type="button"
                  class="ai-time"
                  title="Play from just before"
                  aria-label={`Play retake at ${clock(at ?? 0)}`}
                  onClick={() => play(r)}
                >
                  <Icon name="play" size={12} />
                  {clock(at ?? 0)}
                </button>
                <div class="ai-item-body">
                  <q class="ai-quote">{r.text}</q>
                  <span class="muted small">
                    {r.reason || "Retake"} · Take {take}
                  </span>
                </div>
                <div class="ai-item-actions">
                  {cut || rejected ? (
                    <button type="button" class="link-btn small" onClick={() => reopen(r)}>
                      {cut ? "Restore" : "Reconsider"}
                    </button>
                  ) : (
                    <>
                      <IconButton icon="check" label="Accept: cut it" onClick={() => accept(r)} />
                      <IconButton icon="close" label="Reject: keep it" onClick={() => reject(r)} />
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {(pending.length > 0 || fillers.length > 0 || pauses.length > 0) && items && (
        <div class="ai-footer">
          <Button size="sm" icon="wand" onClick={cleanAll}>
            Clean everything
          </Button>
          <span class="muted small">
            {pending.length} retake{pending.length === 1 ? "" : "s"}, {fillers.length} filler
            {fillers.length === 1 ? "" : "s"}, {pauses.length} pause{pauses.length === 1 ? "" : "s"}
            , in one undo step
          </span>
        </div>
      )}
    </>
  );
}

function Chapters({
  p,
  engine,
  ready,
}: {
  p: Project;
  engine: PreviewEngine | null;
  ready: boolean;
}) {
  const marks = chapterMarks(p, segments.value);
  const list = chapterList(marks);
  const rename = (id: string, title: string) =>
    update(
      (x) => ({ ...x, chapters: x.chapters.map((c) => (c.id === id ? { ...c, title } : c)) }),
      `chapter-${id}`,
    );
  const remove = (id: string) =>
    update((x) => ({ ...x, chapters: x.chapters.filter((c) => c.id !== id) }));
  const addHere = () => {
    const at = clipAt(segments.value, engine?.time.peek() ?? 0);
    if (!at) return;
    update((x) => ({
      ...x,
      chapters: [...x.chapters, { id: newId("c"), clip: at.clip, t: at.t, title: "New chapter" }],
    }));
  };
  return (
    <>
      <p class="muted small">
        Splits the video where a new topic starts. The chapters show on the timeline and give
        YouTube its chapter list.
      </p>
      <RunBar
        tool="chapters"
        label={p.chapters.length ? "Find chapters again" : "Find chapters"}
        busyLabel="Finding where each part starts…"
        disabled={!ready}
        onRun={() =>
          void run(
            "chapters",
            (s, x, signal) => findChapters(s, x, language.value || null, signal),
            (chapters) => update((x) => ({ ...x, chapters })),
          )
        }
      />
      {marks.length > 0 && (
        <ul class="ai-list" aria-label="Chapters">
          {marks.map(({ chapter, at }, i) => (
            <li key={chapter.id} class="ai-item ai-chapter">
              <button
                type="button"
                class="ai-time"
                title="Go there"
                onClick={() => engine?.seek(at)}
              >
                {clock(i === 0 ? 0 : at)}
              </button>
              <input
                class="input input-sm"
                aria-label={`Title of chapter ${i + 1}`}
                value={chapter.title}
                onInput={(e) => rename(chapter.id, e.currentTarget.value)}
              />
              <IconButton
                icon="trash"
                label={`Remove chapter ${i + 1}`}
                onClick={() => remove(chapter.id)}
              />
            </li>
          ))}
        </ul>
      )}
      <div class="ai-footer">
        <Button size="sm" variant="ghost" icon="plus" onClick={addHere}>
          Add one at the playhead
        </Button>
      </div>
      {marks.length > 0 && (
        <div class="ai-block">
          <div class="ai-block-head">
            <span class="field-label">For YouTube</span>
            <CopyButton text={list} />
          </div>
          <pre class="ai-pre">{list}</pre>
          {marks.length < 3 && (
            <p class="muted small">YouTube shows chapters from three on, the first at 0:00.</p>
          )}
        </div>
      )}
    </>
  );
}

function Texts({ p, ready }: { p: Project; ready: boolean }) {
  const setMeta = (key: "summary" | "description", value: string) =>
    update((x) => ({ ...x, meta: { ...x.meta, [key]: value } }), `meta-${key}`);
  return (
    <>
      <p class="muted small">Written from what is said in the edited video, cut words left out.</p>
      <RunBar
        tool="texts"
        label="Write title, summary and description"
        busyLabel="Writing…"
        disabled={!ready}
        onRun={() =>
          void run(
            "texts",
            (s, x, signal) => writeTexts(s, x, language.value || null, signal),
            (t) =>
              update((x) => ({
                ...x,
                title: t.title || x.title,
                meta: { ...x.meta, summary: t.summary, description: t.description },
              })),
          )
        }
      />
      <Field label="Title">
        <input
          class="input"
          value={p.title}
          onInput={(e) => update((x) => ({ ...x, title: e.currentTarget.value }), "title")}
        />
      </Field>
      <div class="ai-block">
        <div class="ai-block-head">
          <span class="field-label">Summary</span>
          <CopyButton text={p.meta.summary} />
        </div>
        <textarea
          class="input ai-text"
          aria-label="Summary"
          rows={3}
          value={p.meta.summary}
          onInput={(e) => setMeta("summary", e.currentTarget.value)}
        />
      </div>
      <div class="ai-block">
        <div class="ai-block-head">
          <span class="field-label">Description</span>
          <CopyButton text={p.meta.description} />
        </div>
        <textarea
          class="input ai-text"
          aria-label="Description"
          rows={6}
          value={p.meta.description}
          onInput={(e) => setMeta("description", e.currentTarget.value)}
        />
      </div>
    </>
  );
}

const POSTS: { key: string; label: string; limit?: number }[] = [
  { key: "linkedin", label: "LinkedIn" },
  { key: "x", label: "X", limit: 280 },
  { key: "youtube", label: "YouTube description" },
];

function Posts({ p, ready }: { p: Project; ready: boolean }) {
  return (
    <>
      <p class="muted small">
        Posts to share the video. [link] marks where its link goes; the YouTube description ends
        with the chapters.
      </p>
      <RunBar
        tool="posts"
        label={Object.keys(p.meta.posts).length ? "Write them again" : "Write posts"}
        busyLabel="Writing the posts…"
        disabled={!ready}
        onRun={() =>
          void run(
            "posts",
            (s, x, signal) => writePosts(s, x, language.value || null, signal),
            (posts) => update((x) => ({ ...x, meta: { ...x.meta, posts } })),
          )
        }
      />
      {POSTS.map(({ key, label, limit }) => {
        const text = p.meta.posts[key] ?? "";
        return (
          <div key={key} class="ai-block">
            <div class="ai-block-head">
              <span class="field-label">{label}</span>
              {limit && (
                <span class={`small ${text.length > limit ? "error" : "muted"}`}>
                  {text.length}/{limit}
                </span>
              )}
              <CopyButton text={text} />
            </div>
            <textarea
              class="input ai-text"
              aria-label={label}
              rows={key === "x" ? 3 : 7}
              value={text}
              placeholder="Not written yet"
              onInput={(e) =>
                update(
                  (x) => ({
                    ...x,
                    meta: { ...x.meta, posts: { ...x.meta.posts, [key]: e.currentTarget.value } },
                  }),
                  `post-${key}`,
                )
              }
            />
          </div>
        );
      })}
    </>
  );
}

export function AiPanel({ engine }: { engine: PreviewEngine | null }) {
  const settingsOpen = useSignal(false);
  useEffect(() => {
    void loadLlmSettings();
  }, []);
  const p = project.value;
  if (!p) return null;
  // Read so the panel follows the settings as they load or change.
  void llmState.value;
  const settings = savedSettings();
  const transcribed = p.clips.some((c) => c.transcript?.words.length);
  const ready = !!settings && transcribed;
  const videoLanguage = languageName(answerLanguage(p));

  return (
    <aside class="inspector ai-panel" aria-label="AI">
      <header class="ai-head">
        <h2>
          <Icon name="sparkles" size={16} /> AI
        </h2>
        <IconButton
          icon="close"
          label="Close the AI panel"
          onClick={() => (aiOpen.value = false)}
        />
      </header>
      <div class="ai-model">
        <span class="muted small" title="The model the tools call">
          {modelLabel(settings)}
        </span>
        <button type="button" class="link-btn small" onClick={() => (settingsOpen.value = true)}>
          AI settings
        </button>
      </div>
      {!settings && (
        <div class="ai-callout">
          <p class="small">
            These tools call your own model, straight from this browser, with your key.
          </p>
          <Button size="sm" variant="primary" onClick={() => (settingsOpen.value = true)}>
            Set up a model
          </Button>
        </div>
      )}
      {settings && !transcribed && (
        <div class="ai-callout">
          <p class="small">Transcribe a take first: the tools work from what was said.</p>
        </div>
      )}
      <label class="ai-lang">
        <span class="muted small">Write in</span>
        <select
          class="input input-sm"
          value={language.value}
          onChange={(e) => (language.value = e.currentTarget.value)}
        >
          <option value="">The video's language ({videoLanguage})</option>
          {RESPONSE_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset class="segmented ai-tabs" aria-label="AI tool">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab.value === t.id}
            class={tab.value === t.id ? "is-on" : ""}
            onClick={() => (tab.value = t.id)}
          >
            {t.label}
            {running.value[t.id] && <span class="ai-dot" aria-hidden="true" />}
          </button>
        ))}
      </fieldset>
      <section class="ai-tool">
        {tab.value === "retakes" && <Retakes p={p} engine={engine} ready={ready} />}
        {tab.value === "chapters" && <Chapters p={p} engine={engine} ready={ready} />}
        {tab.value === "texts" && <Texts p={p} ready={ready} />}
        {tab.value === "posts" && <Posts p={p} ready={ready} />}
      </section>
      {settingsOpen.value && <ModelSettingsModal onClose={() => (settingsOpen.value = false)} />}
    </aside>
  );
}
