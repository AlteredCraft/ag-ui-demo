/**
 * A hand-rolled AG-UI agent endpoint. No agent framework: just
 * POST RunAgentInput in, a stream of AG-UI events out.
 *
 * The server holds no session. Thread history, the ticket (shared state) and
 * even a paused run all arrive in the request, so any instance can pick up
 * any run.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { HEADLINE_TOOL, SUGGEST_TOOL, normalizeTicket, runServerTool, serverTools, systemPrompt, type ToolDef } from "./kitchen.ts";
import { liveModel, streamTurn, type ChatMessage } from "./llm.ts";

const MAX_TURNS = 6;
const INTERRUPT_PREFIX = "headline|";
const PREP_ACTIVITY = "kitchen.prep";
const PREP_STEPS = ["Topic and angle", "Outline", "Hooks", "Headline options", "Your headline pick", "Serve"];
const YOUR_MOVE = 4; // index of the step only the human can complete

type PrepItem = { label: string; status: "todo" | "doing" | "you" | "done"; detail?: string };

export async function handleRun(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return void res.writeHead(405).end();

  // Bad input is rejected before the stream opens; after that, errors are events.
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
  const emit = (event: Record<string, unknown> & { type: EventType }) => res.write(encoder.encodeSSE(event as BaseEvent));

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    await cook(input, emit, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted) emit({ type: EventType.RUN_ERROR, message: err instanceof Error ? err.message : String(err) });
  }
  res.end();
}

type Emit = (event: Record<string, unknown> & { type: EventType }) => void;

async function cook(input: RunAgentInput, emit: Emit, signal: AbortSignal) {
  const { threadId, runId } = input;
  const ticket = normalizeTicket(input.state);
  const history: Message[] = [...input.messages]; // AG-UI shape, for MESSAGES_SNAPSHOT
  const chat = toChat(input.messages); // model shape

  // Tools the browser declared. We can describe them to the model, but only the browser can run them.
  const frontendTools: ToolDef[] = (input.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters }));
  const isFrontend = (name: string) => frontendTools.some((t) => t.name === name);

  const context = (input.context ?? []).map((c) => ({ description: String(c.description).slice(0, 80), value: String(c.value).slice(0, 600) }));
  const resumed = (input.resume ?? []).length > 0;
  const newOrder = !resumed && input.messages.at(-1)?.role === "user";
  if (newOrder) ticket.suggestions = []; // last turn's suggestions are stale now

  emit({ type: EventType.RUN_STARTED, threadId, runId });
  emit({ type: EventType.STATE_SNAPSHOT, snapshot: ticket });

  // The prep list is an ACTIVITY message: structured progress the UI renders
  // as a checklist, patched in place as the work moves along.
  let prepId: string | null = null;
  let prep: PrepItem[] = [];
  const prepSnapshot = (id: string, items: PrepItem[]) => {
    prepId = id;
    prep = items;
    emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: id, activityType: PREP_ACTIVITY, content: { title: "Prep list", items: prep } });
  };
  /** Everything before `current` is done; `current` is in progress (or waiting on the human). */
  const prepAdvance = (current: number, detail?: string) => {
    if (!prepId) return;
    const ops: unknown[] = [];
    prep.forEach((item, i) => {
      const status = i < current ? "done" : i === current ? (i === YOUR_MOVE ? "you" : "doing") : item.status;
      if (status !== item.status) ops.push({ op: "replace", path: `/items/${i}/status`, value: (item.status = status) });
    });
    if (detail && prep[current] && prep[current].detail !== detail) ops.push({ op: "add", path: `/items/${current}/detail`, value: (prep[current].detail = detail) });
    if (ops.length) emit({ type: EventType.ACTIVITY_DELTA, messageId: prepId, activityType: PREP_ACTIVITY, patch: ops });
  };
  if (newOrder && ticket.courses.length === 0) {
    prepSnapshot(`prep-${runId}`, PREP_STEPS.map((label, i) => ({ label, status: i === 0 ? "doing" : "todo" })));
    history.push({ id: prepId!, role: "activity", activityType: PREP_ACTIVITY, content: { title: "Prep list", items: prep } });
  }
  emit({ type: EventType.CUSTOM, name: "kitchen.brain", value: liveModel() ?? "scripted chef (no API key)" });

  const patch = (ops: unknown[]) => ops.length && emit({ type: EventType.STATE_DELTA, delta: ops });
  // Results are emitted the moment a tool finishes, but recorded in history
  // only after the assistant message that made the call (see flushResults).
  let results: { id: string; toolCallId: string; content: string }[] = [];
  const toolResult = (toolCallId: string, content: string) => {
    const id = randomUUID();
    emit({ type: EventType.TOOL_CALL_RESULT, messageId: id, toolCallId, content, role: "tool" });
    results.push({ id, toolCallId, content });
  };
  const flushResults = () => {
    for (const r of results) {
      history.push({ id: r.id, role: "tool", toolCallId: r.toolCallId, content: r.content });
      chat.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
    }
    results = [];
  };

  // Resuming a paused run: the human's answer becomes the result of the tool call that paused it.
  // The interrupt id carries what we need to pick up where we left off: no session store.
  for (const entry of input.resume ?? []) {
    if (!entry.interruptId.startsWith(INTERRUPT_PREFIX)) throw new Error(`unknown interrupt ${entry.interruptId}`);
    const [, toolCallId, activityId] = entry.interruptId.split("|");
    const choice = (entry.payload as { choice?: unknown } | undefined)?.choice;
    if (entry.status === "resolved" && typeof choice === "string" && ticket.headlines.includes(choice)) {
      ticket.chosenHeadline = choice;
      patch([{ op: "replace", path: "/chosenHeadline", value: choice }]);
      toolResult(toolCallId, `The diner picked: "${choice}"`);
    } else {
      toolResult(toolCallId, "The diner sent it back: none of these. Do not propose more unless asked.");
    }
    if (activityId)
      prepSnapshot(
        activityId,
        PREP_STEPS.map((label, i) => ({
          label,
          status: i <= YOUR_MOVE ? "done" : "doing",
          ...(i === YOUR_MOVE && { detail: ticket.chosenHeadline ? "picked" : "sent back" }),
        })),
      );
  }
  flushResults();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stepName = resumed || input.messages.at(-1)?.role === "tool" ? "plating" : turn === 0 ? "mise_en_place" : "on_the_stove";
    emit({ type: EventType.STEP_STARTED, stepName });

    const messageId = randomUUID();
    const reasoningId = randomUUID();
    let text = "";
    let reasoning = "";
    let reasoningOpen = false;
    let textOpen = false;
    let openTool: string | null = null;
    const calls: { id: string; name: string; args: string }[] = [];

    const closeReasoning = () => {
      if (!reasoningOpen) return;
      emit({ type: EventType.REASONING_MESSAGE_END, messageId: reasoningId });
      emit({ type: EventType.REASONING_END, messageId: reasoningId });
      reasoningOpen = false;
    };
    const closeText = () => {
      if (textOpen) emit({ type: EventType.TEXT_MESSAGE_END, messageId });
      textOpen = false;
    };
    let interruptCall: string | null = null;
    let awaitingBrowser = false;
    // A call is complete once the model moves on. Server tools run right then,
    // so the ticket fills in course by course while the model is still talking.
    // Frontend tools are left unanswered for the browser; the headline tool pauses the run.
    const closeTool = () => {
      const c = calls.find((x) => x.id === openTool);
      if (!c) return;
      openTool = null;
      emit({ type: EventType.TOOL_CALL_END, toolCallId: c.id });
      if (isFrontend(c.name)) return void (awaitingBrowser = true);
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(c.args || "{}");
      } catch {
        return toolResult(c.id, "error: arguments were not valid JSON");
      }
      const { ops, result } = runServerTool(ticket, c.name, args);
      patch(ops);
      if (c.name === "set_ticket") prepAdvance(1);
      if (c.name === "add_course") prepAdvance(1, `${ticket.courses.length} section${ticket.courses.length === 1 ? "" : "s"}`);
      if (c.name === "add_garnish") prepAdvance(2, `${ticket.garnish.length} hooks`);
      if (c.name === HEADLINE_TOOL) prepAdvance(YOUR_MOVE, `${ticket.headlines.length} options`);
      if (c.name === HEADLINE_TOOL && ticket.headlines.length >= 2 && !interruptCall) interruptCall = c.id;
      else toolResult(c.id, result || "error: need at least two options");
    };

    const tools = [...serverTools, ...frontendTools];
    const turnInput = { messages: [{ role: "system" as const, content: systemPrompt(ticket, context) }, ...answeredOnly(chat)], tools, ticket, signal };
    for await (const chunk of streamTurn(turnInput)) {
      switch (chunk.type) {
        case "reasoning":
          if (!reasoningOpen) {
            emit({ type: EventType.REASONING_START, messageId: reasoningId });
            emit({ type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning" });
            reasoningOpen = true;
          }
          reasoning += chunk.delta;
          emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: chunk.delta });
          break;
        case "text":
          closeReasoning();
          if (!textOpen) {
            emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
            textOpen = true;
          }
          text += chunk.delta;
          emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: chunk.delta });
          break;
        case "tool_start":
          closeReasoning();
          closeText();
          closeTool();
          openTool = chunk.id;
          calls.push({ id: chunk.id, name: chunk.name, args: "" });
          // parentMessageId hangs the call off this turn's assistant message.
          emit({ type: EventType.TOOL_CALL_START, toolCallId: chunk.id, toolCallName: chunk.name, parentMessageId: messageId });
          break;
        case "tool_args":
          calls.find((c) => c.id === chunk.id)!.args += chunk.delta;
          emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: chunk.id, delta: chunk.delta });
          break;
      }
    }
    closeReasoning();
    closeText();
    closeTool();

    if (reasoning) history.push({ id: reasoningId, role: "reasoning", content: reasoning });
    const toolCalls = calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } }));
    if (text || calls.length) {
      history.push({ id: messageId, role: "assistant", content: text, ...(calls.length && { toolCalls }) });
      chat.push({ role: "assistant", content: text, ...(calls.length && { tool_calls: toolCalls }) });
    }

    if (interruptCall) {
      // A paused run can't also be waiting on the browser, so answer those calls ourselves.
      for (const c of calls) if (isFrontend(c.name)) toolResult(c.id, "skipped: the kitchen is waiting on a headline pick");
      flushResults();
      emit({ type: EventType.STEP_FINISHED, stepName });
      // Snapshots first, so a client that reconnects mid-pause can rebuild everything.
      emit({ type: EventType.STATE_SNAPSHOT, snapshot: ticket });
      emit({ type: EventType.MESSAGES_SNAPSHOT, messages: history });
      emit({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: `${INTERRUPT_PREFIX}${interruptCall}|${prepId ?? ""}`,
              reason: "tool_call",
              toolCallId: interruptCall,
              message: "Which headline should this article run with?",
              responseSchema: { type: "object", properties: { choice: { type: "string", enum: ticket.headlines } }, required: ["choice"] },
              metadata: { "ag-ui:tool-execution": "server" },
            },
          ],
        },
      });
      return;
    }

    flushResults();
    emit({ type: EventType.STEP_FINISHED, stepName });
    if (awaitingBrowser || calls.length === 0) break;
    if (calls.every((c) => c.name === SUGGEST_TOOL)) break; // nothing left to say after suggestions
  }

  if (resumed) prepAdvance(PREP_STEPS.length); // served

  emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: "success" } });
}

/**
 * A stopped run can leave tool calls that never got a result. Models reject
 * that history, so drop the orphans before each request.
 */
function answeredOnly(chat: ChatMessage[]): ChatMessage[] {
  const answered = new Set(chat.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
  return chat.flatMap((m) => {
    if (m.role !== "assistant" || !m.tool_calls) return [m];
    const tool_calls = m.tool_calls.filter((c) => answered.has(c.id));
    if (!tool_calls.length && !m.content) return [];
    return [{ role: "assistant" as const, content: m.content, ...(tool_calls.length && { tool_calls }) }];
  });
}

/** AG-UI messages -> chat-completions messages. Reasoning and activity rows are UI-only. */
function toChat(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const text = (content: unknown) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => (p?.type === "text" ? p.text : "")).join("")
        : "";
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: text(m.content) });
    else if (m.role === "assistant")
      out.push({ role: "assistant", content: text(m.content), ...(m.toolCalls?.length && { tool_calls: m.toolCalls.map(({ id, type, function: fn }) => ({ id, type, function: fn })) }) });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: text(m.content) });
  }
  return out;
}
