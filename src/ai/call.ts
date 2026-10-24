/**
 * One request to the user's model, through llm-connect: the model from the
 * saved settings, its provider options, a check of what it accepts before
 * anything is sent (images included), an answer validated against a zod
 * schema, and errors described without the key.
 */
import { generateText, Output } from "ai";
import {
  callOptions,
  callProblem,
  describeError,
  type LlmSettings,
  loadModel,
  usableEffort,
} from "llm-connect";
import type { z } from "zod";
import { capabilitiesOf } from "./settings";

export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface Ask<S extends z.ZodType> {
  /** Names the answer's schema for the provider (letters, digits and underscores). */
  name: string;
  schema: S;
  instructions: string;
  text: string;
  /** Images after the text, each introduced by its label. */
  images?: readonly { label: string; jpeg: Uint8Array }[];
  effort?: "low" | "medium";
  signal?: AbortSignal | undefined;
}

export async function call<S extends z.ZodType>(
  settings: LlmSettings,
  ask: Ask<S>,
): Promise<z.infer<S>> {
  const { signal } = ask;
  const messages = [
    {
      role: "user" as const,
      content: ask.images?.length
        ? [
            { type: "text" as const, text: ask.text },
            ...ask.images.flatMap((i) => [
              { type: "text" as const, text: i.label },
              { type: "image" as const, image: i.jpeg, mediaType: "image/jpeg" },
            ]),
          ]
        : ask.text,
    },
  ];
  const capabilities = capabilitiesOf(settings);
  const effort = usableEffort(ask.effort ?? "low", capabilities.effort.levels) ?? null;
  const problem = callProblem(settings, { messages, effort }, capabilities);
  if (problem) throw new AiError(problem.message);
  try {
    const model = await loadModel(settings);
    const res = await generateText({
      model,
      instructions: ask.instructions,
      messages,
      output: Output.object({ schema: ask.schema, name: ask.name }),
      maxRetries: 1,
      ...(signal ? { abortSignal: signal } : {}),
      ...callOptions(settings, { effort, capabilities }),
    });
    return res.output as z.infer<S>;
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const e = describeError(err, settings.apiKey);
    const hint =
      e.code === "auth"
        ? " Check the key in AI settings."
        : e.code === "auth-or-network"
          ? " The key was refused, or the network or the provider's CORS policy blocked the request."
          : "";
    throw new AiError(`${e.message || "The model could not answer."}${hint}`, e.retryable);
  }
}

/** Why the model cannot look at images, or null when it can. */
export function visionProblem(settings: LlmSettings): string | null {
  const image = { type: "image" as const, image: new Uint8Array(1), mediaType: "image/jpeg" };
  return (
    callProblem(
      settings,
      { messages: [{ role: "user", content: [image] }] },
      capabilitiesOf(settings),
    )?.message ?? null
  );
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
