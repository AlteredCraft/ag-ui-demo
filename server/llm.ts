/**
 * Two interchangeable "brains" behind one streaming interface:
 *  - OpenRouter (any tool-calling model), when OPENROUTER_API_KEY is set
 *  - a scripted chef, so the demo runs with zero credentials
 *
 * The AG-UI layer in agent.ts cannot tell them apart, which is the point:
 * the protocol sits between agent and UI, not between agent and model.
 */
import { HEADLINE_TOOL, SUGGEST_TOOL, type Ticket, type ToolDef } from "./kitchen.ts";

export type Chunk =
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_args"; id: string; delta: string };

/** OpenAI-style chat messages: the lingua franca both brains read. */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface TurnInput {
  messages: ChatMessage[];
  tools: ToolDef[];
  ticket: Ticket;
  signal: AbortSignal;
}

export const liveModel = () => (process.env.OPENROUTER_API_KEY ? process.env.KITCHEN_MODEL || "anthropic/claude-haiku-5.5" : null);

export function streamTurn(input: TurnInput): AsyncGenerator<Chunk> {
  return liveModel() ? openRouterTurn(input) : scriptedTurn(input);
}

/** One streamed model turn via OpenRouter. Shared by every demo in this repo. */
export async function* openRouterTurn({
  messages,
  tools,
  signal,
  reasoning = true,
}: Pick<TurnInput, "messages" | "tools" | "signal"> & { reasoning?: boolean }): AsyncGenerator<Chunk> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: liveModel(),
      stream: true,
      max_tokens: 3000,
      ...(reasoning && { reasoning: { max_tokens: 1024 } }), // surfaces as REASONING_* events
      messages,
      tools: tools.map((t) => ({ type: "function", function: t })),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`model request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);

  const idByIndex = new Map<number, string>();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of res.body) {
    buffer += decoder.decode(bytes as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const parsed = JSON.parse(data);
      if (parsed.error) throw new Error(parsed.error.message ?? "model stream error");
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning) yield { type: "reasoning", delta: delta.reasoning };
      if (delta.content) yield { type: "text", delta: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        if (tc.id && !idByIndex.has(tc.index)) {
          idByIndex.set(tc.index, tc.id);
          yield { type: "tool_start", id: tc.id, name: tc.function?.name ?? "" };
        }
        const id = idByIndex.get(tc.index);
        if (id && tc.function?.arguments) yield { type: "tool_args", id, delta: tc.function.arguments };
      }
    }
  }
}

/* ---------- the scripted chef ---------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function* say(text: string): AsyncGenerator<Chunk> {
  for (const word of text.match(/\S+\s*/g) ?? []) {
    await sleep(35);
    yield { type: "text", delta: word };
  }
}

async function* mutter(text: string): AsyncGenerator<Chunk> {
  for (const word of text.match(/\S+\s*/g) ?? []) {
    await sleep(20);
    yield { type: "reasoning", delta: word };
  }
}

async function* call(name: string, args: unknown): AsyncGenerator<Chunk> {
  const id = `call_${Date.now().toString(36)}_${n++}`;
  await sleep(250);
  yield { type: "tool_start", id, name };
  const json = JSON.stringify(args);
  for (let i = 0; i < json.length; i += 24) {
    await sleep(25);
    yield { type: "tool_args", id, delta: json.slice(i, i + 24) };
  }
}

async function* scriptedTurn({ messages, tools, ticket }: TurnInput): AsyncGenerator<Chunk> {
  const last = messages.at(-1)!;
  const has = (name: string) => tools.some((t) => t.name === name);
  const toolName = (id: string) =>
    messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []) : [])).find((c) => c.id === id)?.function.name;

  if (last.role === "tool") {
    const name = toolName(last.tool_call_id);
    if (name === HEADLINE_TOOL) {
      const sentBack = last.content.includes("sent it back");
      yield* say(sentBack ? "Heard. Scrapping the menu board, you name it yourself. " : "Good palate. That one sells itself. ");
      if (has("ring_bell")) yield* call("ring_bell", { message: ticket.chosenHeadline ?? ticket.dish });
      yield* call(SUGGEST_TOOL, { options: ["Add a section on cost", "Make the opener punchier", "Fine dining, please"] });
      return;
    }
    if (name === "ring_bell") return yield* say("Order up! Tweak the ticket by hand or shout if you want it re-fired.");
    if (name === "set_kitchen_vibe") return yield* say("New decor, same knives. What are we cooking?");
    return yield* say("Done. Ticket's updated.");
  }

  const ask = last.content.toLowerCase();
  const vibe = /fine|fancy|michelin/.test(ask) ? "fine_dining" : /truck|street/.test(ask) ? "food_truck" : /diner|classic/.test(ask) ? "diner" : null;
  if (vibe && has("set_kitchen_vibe")) {
    yield* say("Redecorating on the fly. ");
    return yield* call("set_kitchen_vibe", { vibe });
  }

  if (ticket.courses.length > 0) {
    yield* mutter("Ticket's already on the rail. One more course, keep it tight. ");
    yield* say("Heard, adding a course on the fly. ");
    yield* call("add_course", {
      title: "The part everyone skips",
      note: `Per the diner: "${last.content.slice(0, 80)}". Address it head on, with one concrete example.`,
    });
    return yield* call(SUGGEST_TOOL, { options: ["Tighten the outline", "Add a counterargument section", "Food truck vibes"] });
  }

  const dish = last.content.replace(/^(cook|write|make)( me)?( up)?:?\s*/i, "").slice(0, 60) || "something off-menu";
  const hot = ticket.spice >= 4;
  yield* mutter(`New ticket: ${dish}. Spice ${ticket.spice} of 5, so ${hot ? "lead with the fight" : "keep it balanced"}. Four courses, one garnish, then headlines. `);
  yield* say("Heard! Firing it now, watch the ticket. ");
  yield* call("set_ticket", {
    dish,
    angle: hot ? `Everything you were told about ${dish} is backwards.` : `A practical field guide to ${dish}.`,
    audience: "Developers shipping AI features",
  });
  yield* call("add_course", { title: "The mess on the counter", note: "Open with the pain: what breaks today, shown with one real example." });
  yield* call("add_course", { title: "Mise en place", note: "The two or three concepts the reader needs before anything else makes sense." });
  yield* call("add_course", { title: "On the stove", note: "Build the thing step by step. Code where it earns its place." });
  yield* call("add_course", { title: "Send it back", note: "Where this approach fails, and what to reach for instead." });
  yield* call("add_garnish", { text: "A protocol is just a menu both sides agreed to read." });
  yield* call(HEADLINE_TOOL, {
    options: hot
      ? [`${dish} Is Overcooked`, `Stop Plating ${dish} Like It's 2023`, `The ${dish} Hot Take Nobody Ordered`]
      : [`${dish}, Served Simply`, `A Working Cook's Guide to ${dish}`, `${dish}: From Prep to Plate`],
  });
}
