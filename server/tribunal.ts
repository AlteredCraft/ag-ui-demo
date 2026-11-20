/**
 * The Tribunal: an orchestrator that runs three judge subagents AT THE SAME
 * TIME and multiplexes their output onto a single AG-UI stream.
 *
 * Each judge is its own model call. Every event a judge produces carries its
 * subagentRunId, which is how one SSE connection can hold three interleaved
 * conversations and the UI can still route every token to the right card.
 *
 * Like the kitchen, this endpoint is stateless: the pitch, each judge's take
 * and score live in shared state, and come back with the resume request.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { liveModel, openRouterTurn, type ChatMessage, type Chunk } from "./llm.ts";
import type { ToolDef } from "./kitchen.ts";

interface Judge {
  name: string;
  title: string;
  emoji: string;
  score: number | null;
  prev: number | null; // score before the rebuttal
  quip: string;
  take: string; // round 1
  reply: string; // round 2
}
interface Docket {
  pitch: string;
  round: number; // 0 idle, 1 opening takes, 2 after rebuttal
  rebuttal: string;
  order: string[];
  judges: Record<string, Judge>;
  verdict: { label: string; reason: string } | null;
}

const PANEL: Record<string, { name: string; title: string; emoji: string; persona: string; canned: string[]; bias: number }> = {
  sre: {
    name: "Pager",
    title: "On-call SRE, has not slept since 2019",
    emoji: "📟",
    persona:
      "You are Pager, a battle-scarred on-call SRE. You judge everything by what happens at 3am when it breaks, who gets paged, and how you roll it back. Dry, weary, darkly funny. You respect boring technology.",
    canned: ["I can already hear the pager. Where's the rollback plan, and who owns this at 3am? If the answer is 'the model', I'm going back to bed.", "Fine. A runbook and a kill switch and I'll stop twitching."],
    bias: -1,
  },
  vc: {
    name: "Blitz",
    title: "Venture capitalist, pre-seed to pre-reality",
    emoji: "🚀",
    persona:
      "You are Blitz, a relentlessly optimistic venture capitalist. Everything is a platform, a flywheel, or a category-defining wedge. You talk in TAM and vibes, and occasionally say something accidentally insightful. Breathless and funny.",
    canned: ["This isn't a feature, it's a category. I see a flywheel, I see a wedge, I see a deck with one slide that just says 'inevitable'.", "The pushback only makes the moat deeper. I'm doubling my imaginary check."],
    bias: 2,
  },
  staff: {
    name: "Dr. No",
    title: "Staff engineer, author of 400 design-doc comments",
    emoji: "🧐",
    persona:
      "You are Dr. No, a staff engineer who has seen every idea fail twice. You ask what the simplest boring alternative is, and whether a cron job and a spreadsheet would do. Precise, skeptical, deadpan, fair when a point is good.",
    canned: ["What problem does this solve that a cron job and a spreadsheet don't? I ask because the last three versions of this idea are still in our repo, unowned.", "That is a better answer than I expected. I remain unconvinced, but less loudly."],
    bias: 0,
  },
};

const SCORE_TOOL: ToolDef = {
  name: "score",
  description: "Hold up your scorecard. Call exactly once, after your spoken take.",
  parameters: {
    type: "object",
    properties: { score: { type: "integer", minimum: 1, maximum: 10 }, quip: { type: "string", description: "Scorecard caption, max 8 words" } },
    required: ["score", "quip"],
  },
};

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** Client state is untrusted: rebuild a well-formed docket from it. */
function normalize(raw: unknown): Docket {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const judges: Record<string, Judge> = {};
  for (const [id, j] of Object.entries(PANEL)) {
    const prior = r.judges?.[id] ?? {};
    const num = (v: unknown) => (typeof v === "number" ? Math.min(10, Math.max(1, Math.round(v))) : null);
    judges[id] = { name: j.name, title: j.title, emoji: j.emoji, score: num(prior.score), prev: num(prior.prev), quip: clip(prior.quip, 80), take: clip(prior.take, 900), reply: clip(prior.reply, 600) };
  }
  return { pitch: clip(r.pitch, 400), round: r.round === 1 || r.round === 2 ? r.round : 0, rebuttal: clip(r.rebuttal, 400), order: Object.keys(PANEL), judges, verdict: null };
}

type Emit = (event: Record<string, unknown> & { type: EventType }) => void;

export async function handleTribunal(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return void res.writeHead(405).end();
  let input: RunAgentInput;
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    input = JSON.parse(body);
    if (!input.threadId || !input.runId || !Array.isArray(input.messages)) throw new Error("not a RunAgentInput");
  } catch (err) {
    return void res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(err) }));
  }

  const encoder = new EventEncoder();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const emit: Emit = (event) => void res.write(encoder.encodeSSE(event as BaseEvent));
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  try {
    await session(input, emit, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted) emit({ type: EventType.RUN_ERROR, message: err instanceof Error ? err.message : String(err) });
  }
  res.end();
}

async function session(input: RunAgentInput, emit: Emit, signal: AbortSignal) {
  const { threadId, runId } = input;
  const docket = normalize(input.state);
  const history: Message[] = [...input.messages];
  const resume = input.resume?.[0];

  emit({ type: EventType.RUN_STARTED, threadId, runId });
  emit({ type: EventType.CUSTOM, name: "tribunal.brain", value: liveModel() ?? "scripted judges (no API key)" });

  if (!resume) {
    // Round 1: a fresh pitch. Everything the UI shows starts from this snapshot.
    const last = input.messages.at(-1);
    const pitch = last?.role === "user" && typeof last.content === "string" ? last.content.trim().slice(0, 400) : "";
    if (!pitch) throw new Error("No pitch to judge.");
    Object.assign(docket, normalize({}), { pitch, round: 1 });
    emit({ type: EventType.STATE_SNAPSHOT, snapshot: docket });

    await convene(docket, 1, history, emit, signal);

    // Pause for the human. The form the UI shows is generated from responseSchema.
    emit({ type: EventType.STATE_SNAPSHOT, snapshot: docket });
    emit({ type: EventType.MESSAGES_SNAPSHOT, messages: history });
    emit({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: `rebuttal-${runId}`,
            reason: "input_required",
            message: "The panel has spoken. Do you wish to respond before the verdict?",
            responseSchema: {
              type: "object",
              properties: { rebuttal: { type: "string", title: "Your rebuttal", description: "One shot. Judges may change their scores.", maxLength: 280 } },
              required: ["rebuttal"],
            },
          },
        ],
      },
    });
    return;
  }

  // Round 2: the rebuttal (or a refusal to give one) arrives as the resume payload.
  if (!docket.pitch || docket.round !== 1) throw new Error("Nothing to resume: this docket has no open rebuttal.");
  const rebuttal = resume.status === "resolved" ? clip((resume.payload as any)?.rebuttal, 280).trim() : "";
  emit({ type: EventType.STATE_SNAPSHOT, snapshot: docket });
  if (rebuttal) {
    docket.rebuttal = rebuttal;
    docket.round = 2;
    const ops: unknown[] = [
      { op: "replace", path: "/rebuttal", value: rebuttal },
      { op: "replace", path: "/round", value: 2 },
    ];
    for (const id of docket.order) ops.push({ op: "replace", path: `/judges/${id}/prev`, value: (docket.judges[id].prev = docket.judges[id].score) });
    emit({ type: EventType.STATE_DELTA, delta: ops });
    await convene(docket, 2, history, emit, signal);
  }

  await verdict(docket, input, emit, signal);
  emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "success" } });
}

/** Runs every judge concurrently. One failing judge does not stop the others. */
async function convene(docket: Docket, round: 1 | 2, history: Message[], emit: Emit, signal: AbortSignal) {
  const stepName = round === 1 ? "opening_takes" : "rebuttal_round";
  emit({ type: EventType.STEP_STARTED, stepName });
  await Promise.all(docket.order.map((id) => judge(id, docket, round, history, emit, signal)));
  emit({ type: EventType.STEP_FINISHED, stepName });
}

async function judge(id: string, docket: Docket, round: 1 | 2, history: Message[], emit: Emit, signal: AbortSignal) {
  const me = docket.judges[id];
  const subagentRunId = randomUUID();
  const messageId = randomUUID();
  // Stamp everything this judge emits, so the client can demultiplex.
  const say: Emit = (event) => emit({ ...event, subagentRunId });
  emit({ type: EventType.SUBAGENT_STARTED, subagentRunId, name: id, description: `${me.name}: ${round === 1 ? "opening take" : "response to the rebuttal"}` });

  try {
    let text = "";
    let textOpen = false;
    let call: { id: string; args: string } | null = null;
    for await (const chunk of judgeStream(id, docket, round, signal)) {
      if (chunk.type === "text") {
        if (call) continue; // nothing to add after the scorecard is up
        if (!textOpen) say({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
        textOpen = true;
        text += chunk.delta;
        say({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: chunk.delta });
      } else if (chunk.type === "tool_start" && !call && chunk.name === SCORE_TOOL.name) {
        if (textOpen) say({ type: EventType.TEXT_MESSAGE_END, messageId });
        textOpen = false;
        call = { id: chunk.id, args: "" };
        say({ type: EventType.TOOL_CALL_START, toolCallId: call.id, toolCallName: SCORE_TOOL.name, parentMessageId: messageId });
      } else if (chunk.type === "tool_args" && call?.id === chunk.id) {
        call.args += chunk.delta;
        say({ type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: chunk.delta });
      }
    }
    if (textOpen) say({ type: EventType.TEXT_MESSAGE_END, messageId });

    const field = round === 1 ? "take" : "reply";
    me[field] = text.trim();
    const ops: unknown[] = [{ op: "replace", path: `/judges/${id}/${field}`, value: me[field] }];
    if (call) {
      say({ type: EventType.TOOL_CALL_END, toolCallId: call.id });
      let args: any = {};
      try {
        args = JSON.parse(call.args || "{}");
      } catch {}
      if (typeof args.score === "number") {
        me.score = Math.min(10, Math.max(1, Math.round(args.score)));
        me.quip = clip(args.quip, 80);
        ops.push({ op: "replace", path: `/judges/${id}/score`, value: me.score }, { op: "replace", path: `/judges/${id}/quip`, value: me.quip });
      }
      const resultId = randomUUID();
      say({ type: EventType.TOOL_CALL_RESULT, messageId: resultId, toolCallId: call.id, content: "scorecard shown", role: "tool" });
      history.push({ id: messageId, role: "assistant", content: text, toolCalls: [{ id: call.id, type: "function", function: { name: SCORE_TOOL.name, arguments: call.args || "{}" } }] });
      history.push({ id: resultId, role: "tool", toolCallId: call.id, content: "scorecard shown" });
    } else if (text) history.push({ id: messageId, role: "assistant", content: text });
    say({ type: EventType.STATE_DELTA, delta: ops });
    emit({ type: EventType.SUBAGENT_FINISHED, subagentRunId, result: { score: me.score }, outcome: { type: "success" } });
  } catch (err) {
    if (signal.aborted) throw err;
    emit({ type: EventType.SUBAGENT_ERROR, subagentRunId, message: err instanceof Error ? err.message : String(err) });
  }
}

function judgeStream(id: string, docket: Docket, round: 1 | 2, signal: AbortSignal): AsyncGenerator<Chunk> {
  if (!liveModel()) return scriptedJudge(id, docket, round);
  const me = docket.judges[id];
  const rules = `${PANEL[id].persona}

You sit on a three-judge panel reviewing pitches from software developers. Stay fully in character. Plain text only: no markdown, no emoji, no stage directions. Be specific to the pitch, never generic. Then call the score tool exactly once (1 = bury it, 10 = ship it today).`;
  const messages: ChatMessage[] = [
    { role: "system", content: rules },
    { role: "user", content: `The pitch: "${docket.pitch}"\n\nGive your opening take in at most 45 words, then score it.` },
  ];
  if (round === 2)
    messages.push(
      { role: "assistant", content: `${me.take}\n\n(I scored it ${me.score ?? "?"}/10.)` },
      { role: "user", content: `The pitcher's rebuttal: "${docket.rebuttal}"\n\nRespond directly to the rebuttal in at most 30 words. Do not state your score in words. Then score again: move your score if they earned it (up or down), hold if not.` },
    );
  return openRouterTurn({ messages, tools: [SCORE_TOOL], signal, reasoning: false });
}

/** The chair speaks on the main run (no subagentRunId), then asks the browser to stamp the result. */
async function verdict(docket: Docket, input: RunAgentInput, emit: Emit, signal: AbortSignal) {
  emit({ type: EventType.STEP_STARTED, stepName: "verdict" });
  const stamp = (input.tools ?? []).find((t) => t.name === "stamp_verdict");
  const scores = docket.order.map((id) => docket.judges[id].score ?? 5);
  const average = scores.reduce((a, b) => a + b, 0) / scores.length;
  const messageId = randomUUID();
  let textOpen = false;
  let call: string | null = null;

  const stream: AsyncGenerator<Chunk> = liveModel()
    ? openRouterTurn({
        signal,
        reasoning: false,
        tools: stamp ? [{ name: stamp.name, description: stamp.description, parameters: stamp.parameters }] : [],
        messages: [
          {
            role: "system",
            content:
              "You are the Chair of a three-judge tribunal for developer pitches: grand, theatrical, brief. Deliver the verdict in 2 sentences of plain text (no markdown, no emoji), naming the decisive argument. Then call stamp_verdict once, with a reason of at most 12 words. Rule by the scores: average 7 or more is SHIP IT, 4.5 to 7 is NEEDS WORK, below 4.5 is BURN IT DOWN.",
          },
          {
            role: "user",
            content: `Pitch: "${docket.pitch}"\nRebuttal: ${docket.rebuttal ? `"${docket.rebuttal}"` : "(none offered)"}\n${docket.order
              .map((id) => `${docket.judges[id].name} scored ${docket.judges[id].score}/10: ${docket.judges[id].reply || docket.judges[id].take}`)
              .join("\n")}\nAverage: ${average.toFixed(1)}`,
          },
        ],
      })
    : scriptedChair(average, !!stamp);

  for await (const chunk of stream) {
    if (chunk.type === "text" && !call) {
      if (!textOpen) emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
      textOpen = true;
      emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: chunk.delta });
    } else if (chunk.type === "tool_start" && !call) {
      if (textOpen) emit({ type: EventType.TEXT_MESSAGE_END, messageId });
      textOpen = false;
      call = chunk.id;
      emit({ type: EventType.TOOL_CALL_START, toolCallId: call, toolCallName: chunk.name, parentMessageId: messageId });
    } else if (chunk.type === "tool_args" && chunk.id === call) emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: call, delta: chunk.delta });
  }
  if (textOpen) emit({ type: EventType.TEXT_MESSAGE_END, messageId });
  if (call) emit({ type: EventType.TOOL_CALL_END, toolCallId: call }); // a frontend tool: the browser answers it
  emit({ type: EventType.STEP_FINISHED, stepName: "verdict" });
}

/* ---------- scripted fallback: same protocol, no model ---------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* words(text: string, pace: number): AsyncGenerator<Chunk> {
  for (const word of text.match(/\S+\s*/g) ?? []) {
    await sleep(pace + Math.random() * pace);
    yield { type: "text", delta: word };
  }
}

async function* toolCall(name: string, args: unknown): AsyncGenerator<Chunk> {
  const id = `call_${randomUUID().slice(0, 8)}`;
  yield { type: "tool_start", id, name };
  const json = JSON.stringify(args);
  for (let i = 0; i < json.length; i += 16) {
    await sleep(30);
    yield { type: "tool_args", id, delta: json.slice(i, i + 16) };
  }
}

async function* scriptedJudge(id: string, docket: Docket, round: 1 | 2): AsyncGenerator<Chunk> {
  const p = PANEL[id];
  let hash = 0;
  for (const ch of docket.pitch) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const base = Math.min(10, Math.max(1, 4 + (hash % 4) + p.bias));
  yield* words(p.canned[round - 1], 35 + Object.keys(PANEL).indexOf(id) * 12);
  const score = round === 1 ? base : Math.min(10, base + (docket.rebuttal.length > 40 ? 2 : 1));
  yield* toolCall("score", { score, quip: round === 1 ? ["Page me never", "Take my money", "Have you tried cron"][Object.keys(PANEL).indexOf(id)] : "Marginally persuaded" });
}

async function* scriptedChair(average: number, canStamp: boolean): AsyncGenerator<Chunk> {
  const label = average >= 7 ? "SHIP IT" : average >= 4.5 ? "NEEDS WORK" : "BURN IT DOWN";
  yield* words(`The tribunal has weighed the evidence, and the scorecards average ${average.toFixed(1)}. So ruled.`, 40);
  if (canStamp) yield* toolCall("stamp_verdict", { verdict: label, reason: "The scorecards have spoken." });
}
