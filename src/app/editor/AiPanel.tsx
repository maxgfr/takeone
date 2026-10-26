/**
 * The AI panel, in place of the settings while it is open. Everything in it
 * works from the transcript (the words kept, whichever voice they come from).
 * Edit is a conversation: say what you want in plain words, or pick a quick
 * request (the full automatic edit, fixing the transcript, a shorter version,
 * zooms, chapters); each answer lands in one undo step, its changes listed to
 * go to or drop, with the length before and after. The chapters stay editable
 * below. Texts writes the title, the summary, the description and the posts.
 * Every request calls the user's own model and can be cancelled.
 */
import { signal, useSignal } from "@preact/signals";
import { type LlmSettings, languageName, RESPONSE_LANGUAGES } from "llm-connect";
import { useEffect } from "preact/hooks";
import { applyAsk, askEdit } from "../../ai/ask";
import { visionProblem } from "../../ai/call";
import { applyPlan, type EditNote, planEdit } from "../../ai/edit";
import { llmState, loadLlmSettings, modelLabel, savedSettings } from "../../ai/settings";
import { answerLanguage, writePosts, writeTexts } from "../../ai/tools";
import { chapterList, chapterMarks, chapterTime } from "../../edit/chapters";
import { isCut } from "../../edit/clean";
import { clipAt, removeItem } from "../../edit/ops";
import type { PreviewEngine } from "../../edit/preview";
import {
  type ClipTranscript,
  newId,
  type Project,
  shownOf,
  withTranscript,
} from "../../model/project";
import { ModelSettingsModal } from "../ModelSettings";
import { clock } from "../Record";
import { Button, copyText, errorText, Field, Icon, IconButton, toast } from "../ui";
import { duration, project, segments, update, updateClip } from "./state";

/** The panel is open. */
export const aiOpen = signal(false);

type Tool = "edit" | "texts";
const TABS: { id: Tool; label: string }[] = [
  { id: "edit", label: "Edit" },
  { id: "texts", label: "Texts" },
];

const tab = signal<Tool>("edit");
/** "" writes in the video's language. */
const language = signal("");
const running = signal<Partial<Record<Tool, AbortController>>>({});
const failed = signal<Partial<Record<Tool, string>>>({});

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

/** One request and what came of it. */
interface Turn {
  id: string;
  request: string;
  reply: string;
  notes: EditNote[];
  /** For each word correction listed: the take, its text before and after. */
  fixes: Record<string, { clip: string; before: ClipTranscript; after: ClipTranscript }>;
  /** The edited video's length before and after. */
  from: number;
  to: number;
}

/** The conversation, for one project. */
const turns = signal<{ project: string; items: Turn[] } | null>(null);
const draft = signal("");
/** Show the model the screen (for zooms and blurs). */
const see = signal(true);
const step = signal("");

/** One click for what people ask most; `full` is the whole automatic edit. */
const QUICK: { label: string; request: string; see?: boolean; full?: boolean }[] = [
  { label: "Full edit", request: "Edit the whole video", full: true },
  {
    label: "Fix the transcript",
    request: "Fix the words the speech recognition got wrong. Change nothing else.",
    see: false,
  },
  {
    label: "Tighten",
    request:
      "Tighten the video: cut the failed attempts, the repetitions, the hesitations and the digressions. Keep everything that carries meaning.",
    see: false,
  },
  {
    label: "30-second version",
    request:
      "Make the video about 30 seconds long: keep the strongest part that makes sense on its own, cut the rest.",
    see: false,
  },
  {
    label: "Zoom on what I show",
    request: "Zoom on what I talk about or click, where seeing it closer helps.",
    see: true,
  },
  { label: "Chapters", request: "Split the video into chapters.", see: false },
];

function stillThere(p: Project, n: EditNote, turn: Turn): boolean {
  switch (n.kind) {
    case "zoom":
      return p.zooms.some((z) => z.id === n.id);
    case "layout":
      return p.layouts.some((l) => l.id === n.id);
    case "blur":
      return p.blurs.some((b) => b.id === n.id);
    case "cut":
      return !n.id || p.cuts.some((c) => c.id === n.id);
    case "chapter":
      return p.chapters.some((c) => c.id === n.id);
    case "fix": {
      const f = turn.fixes[n.id];
      return !!f && p.clips.find((c) => c.id === f.clip)?.transcript === f.after;
    }
  }
}

function addTurn(p: Project, turn: Omit<Turn, "id">) {
  const mine = turns.value?.project === p.id ? turns.value.items : [];
  turns.value = { project: p.id, items: [...mine, { ...turn, id: newId("t") }] };
}

/** Sends a request (or runs the full edit) and applies what comes back, in one undo step. */
function ask(p: Project, request: string, opts: { see: boolean; full?: boolean }) {
  const text = request.trim();
  if (!text) return;
  const history = (turns.value?.project === p.id ? turns.value.items : []).map((t) => ({
    request: t.request,
    reply: t.reply,
  }));
  const from = duration.peek();
  const progress = (m: string) => (step.value = m);
  if (opts.full) {
    void run(
      "edit",
      (s, x, signal) =>
        planEdit(s, x, {
          visual: true,
          retakes: true,
          clean: true,
          chapters: true,
          language: null,
          signal,
          onProgress: progress,
        }),
      (plan) => {
        step.value = "";
        update((x) => applyPlan(x, plan, true));
        addTurn(p, {
          request: text,
          reply: plan.notes.length
            ? "Zooms, layouts, blurs, retakes, filler words, pauses and chapters, in one step."
            : "Nothing to change.",
          notes: plan.notes,
          fixes: {},
          from,
          to: duration.peek(),
        });
      },
    );
    return;
  }
  void run(
    "edit",
    (s, x, signal) => askEdit(s, x, text, { history, see: opts.see, signal, onProgress: progress }),
    (plan) => {
      step.value = "";
      update((x) => applyAsk(x, plan));
      const fixes: Turn["fixes"] = {};
      for (const f of plan.fixes) {
        updateClip(f.clip, (c) => withTranscript(c, shownOf(c), f.after));
        fixes[`fix-${f.clip}`] = f;
      }
      addTurn(p, {
        request: text,
        reply: plan.reply || (plan.notes.length ? "Done." : "Nothing to change."),
        notes: plan.notes,
        fixes,
        from,
        to: duration.peek(),
      });
      draft.value = "";
    },
  );
}

function Changes({ p, turn, engine }: { p: Project; turn: Turn; engine: PreviewEngine | null }) {
  const segs = segments.value;
  const kept = turn.notes.filter((n) => stillThere(p, n, turn));
  if (!kept.length) return null;
  const drop = (n: EditNote) => {
    if (n.kind === "fix") {
      const f = turn.fixes[n.id];
      if (f) updateClip(f.clip, (c) => withTranscript(c, shownOf(c), f.before));
    } else if (n.kind === "chapter")
      update((x) => ({ ...x, chapters: x.chapters.filter((c) => c.id !== n.id) }));
    else if (n.id) update((x) => removeItem(x, n.kind as "zoom" | "layout" | "blur" | "cut", n.id));
  };
  const go = (n: EditNote) => {
    const at = chapterTime(segs, { clip: n.clip, t: n.t });
    if (at !== null) engine?.seek(Math.max(0, at - 0.3));
  };
  return (
    <ul class="ai-list" aria-label="Changes">
      {kept.map((n, i) => {
        const at = chapterTime(segs, { clip: n.clip, t: n.t });
        return (
          <li key={n.id || `${n.what}-${i}`} class="ai-item ai-change">
            <button
              type="button"
              class="ai-time"
              title="Go there"
              aria-label={`Go to ${clock(at ?? 0)}`}
              onClick={() => go(n)}
            >
              {clock(at ?? 0)}
            </button>
            <div class="ai-item-body">
              <span>{n.what}</span>
              {n.why && <span class="muted small">{n.why}</span>}
            </div>
            {n.id && (
              <div class="ai-item-actions">
                <IconButton icon="close" label={`Drop: ${n.what}`} onClick={() => drop(n)} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Edit({ p, engine, ready }: { p: Project; engine: PreviewEngine | null; ready: boolean }) {
  const settings = savedSettings();
  const blind = settings ? visionProblem(settings) : null;
  const items = turns.value?.project === p.id ? turns.value.items : [];
  const busy = !!running.value.edit;
  const error = failed.value.edit;
  const send = () => ask(p, draft.value, { see: see.value });

  return (
    <>
      <form
        class="ai-ask"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          class="input ai-prompt"
          aria-label="Ask the AI"
          rows={3}
          placeholder="Tell it what to do: “cut the intro”, “make it 45 seconds”, “zoom when I click Save”, “bring back the sentence about pricing”…"
          value={draft.value}
          disabled={!ready}
          onInput={(e) => (draft.value = e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              if (!busy) send();
            }
          }}
        />
        <div class="ai-ask-bar">
          <label class="check small" title={blind ?? undefined}>
            <input
              type="checkbox"
              checked={see.value && !blind}
              disabled={!!blind}
              onChange={(e) => (see.value = e.currentTarget.checked)}
            />
            Show it the screen
          </label>
          {busy ? (
            <Button size="sm" variant="ghost" onClick={() => cancel("edit")}>
              Cancel
            </Button>
          ) : (
            <Button
              type="submit"
              size="sm"
              icon="sparkles"
              class="btn-ai"
              disabled={!ready || !draft.value.trim()}
            >
              Send
            </Button>
          )}
        </div>
      </form>
      <fieldset class="ai-quick" aria-label="Quick requests">
        {QUICK.map((q) => (
          <button
            key={q.label}
            type="button"
            class="ai-chip"
            disabled={!ready || busy}
            title={
              q.full
                ? "Zooms, layouts, blurs, retakes, filler words, pauses and chapters"
                : q.request
            }
            onClick={() =>
              ask(p, q.full ? q.label : q.request, { see: q.see ?? see.value, full: !!q.full })
            }
          >
            {q.label}
          </button>
        ))}
      </fieldset>
      {busy && (
        <div class="ai-busy" role="status">
          <span class="spinner spinner-sm" aria-hidden="true" />
          <span>{step.value || "Thinking…"}</span>
        </div>
      )}
      {error && (
        <p class="error small" role="alert">
          {error}
        </p>
      )}
      {items.length > 0 && (
        <ol class="ai-turns" aria-label="Requests">
          {items.map((t) => (
            <li key={t.id} class="ai-turn">
              <p class="ai-req">{t.request}</p>
              <p class="ai-reply">
                {t.reply}
                {Math.abs(t.to - t.from) >= 0.5 && (
                  <span class="ai-length">
                    {" "}
                    {clock(t.from)} → {clock(t.to)}
                  </span>
                )}
              </p>
              <Changes p={p} turn={t} engine={engine} />
            </li>
          ))}
        </ol>
      )}
      {items.length > 0 && (
        <p class="muted small">Undo a whole request with ⌘Z, or drop one change with its ×.</p>
      )}
      <Chapters p={p} engine={engine} />
    </>
  );
}

/** The chapters, found by the edit or added by hand: renamed, removed, copied for YouTube. */
function Chapters({ p, engine }: { p: Project; engine: PreviewEngine | null }) {
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
    <section class="ai-section" aria-label="Chapters">
      <h3 class="field-label">Chapters</h3>
      {marks.length === 0 && (
        <p class="muted small">
          None yet: the edit finds them where a new topic starts, or add one at the playhead.
        </p>
      )}
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
    </section>
  );
}

function Texts({ p, ready }: { p: Project; ready: boolean }) {
  const setMeta = (key: "summary" | "description", value: string) =>
    update((x) => ({ ...x, meta: { ...x.meta, [key]: value } }), `meta-${key}`);
  const videoLanguage = languageName(answerLanguage(p));
  return (
    <>
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

      <p class="muted small">
        Written from the transcript of the edited video, cut words left out. [link] marks where the
        video's link goes; the YouTube description ends with the chapters.
      </p>
      <RunBar
        tool="texts"
        label={p.meta.summary ? "Write them again" : "Write title, summary and posts"}
        busyLabel="Writing…"
        disabled={!ready}
        onRun={() =>
          void run(
            "texts",
            async (s, x, signal) => {
              const t = await writeTexts(s, x, language.value || null, signal);
              // The posts start from the new title and summary.
              const told = {
                ...x,
                title: t.title || x.title,
                meta: { ...x.meta, summary: t.summary, description: t.description },
              };
              return [t, await writePosts(s, told, language.value || null, signal)] as const;
            },
            ([t, posts]) =>
              update((x) => ({
                ...x,
                title: t.title || x.title,
                meta: { ...x.meta, summary: t.summary, description: t.description, posts },
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
      <Posts p={p} />
    </>
  );
}

const POSTS: { key: string; label: string; limit?: number }[] = [
  { key: "linkedin", label: "LinkedIn" },
  { key: "x", label: "X", limit: 280 },
  { key: "youtube", label: "YouTube description" },
];

function Posts({ p }: { p: Project }) {
  return (
    <>
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
  const words = p.clips.reduce(
    (n, c) => n + (c.transcript?.words.filter((w) => !isCut(p.cuts, c.id, w)).length ?? 0),
    0,
  );
  const takes = p.clips.filter((c) => c.transcript?.words.length).length;
  const transcribed = takes > 0;
  const ready = !!settings && transcribed;

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
      {transcribed ? (
        <p class="muted small ai-source">
          Works from the transcript: {takes} take{takes === 1 ? "" : "s"}, {words} word
          {words === 1 ? "" : "s"} kept.
        </p>
      ) : (
        <div class="ai-callout">
          <p class="small">
            The AI works from the transcript: transcribe a take, or write its text, first.
          </p>
        </div>
      )}
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
        {tab.value === "edit" && <Edit p={p} engine={engine} ready={ready} />}
        {tab.value === "texts" && <Texts p={p} ready={ready} />}
      </section>
      {settingsOpen.value && <ModelSettingsModal onClose={() => (settingsOpen.value = false)} />}
    </aside>
  );
}
