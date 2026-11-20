/**
 * The dining room. Everything on screen is derived from three things the
 * AG-UI client maintains for us: agent.messages, agent.state, and the raw
 * event stream.
 */
import { HttpAgent, type AgentSubscriber } from "@ag-ui/client";
import type { BaseEvent, Interrupt, Message, Tool } from "@ag-ui/core";
import confetti from "canvas-confetti";
import { WireTap } from "./wiretap";

interface Course { id: string; title: string; note: string }
interface Ticket {
  dish: string; angle: string; audience: string; spice: number;
  courses: Course[]; garnish: string[]; headlines: string[]; chosenHeadline: string | null; suggestions: string[];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const uid = () => crypto.randomUUID();

/* ---------- frontend tools: declared here, called by the agent, run in this tab ---------- */

const VIBES = ["diner", "fine_dining", "food_truck"];
const frontendTools: Tool[] = [
  {
    name: "ring_bell",
    description: "Ring the service bell in the dining room to announce a finished dish. Runs in the diner's browser.",
    parameters: { type: "object", properties: { message: { type: "string", description: "What to announce, e.g. the chosen headline" } }, required: ["message"] },
  },
  {
    name: "set_kitchen_vibe",
    description: "Redecorate the dining room. Runs in the diner's browser.",
    parameters: { type: "object", properties: { vibe: { type: "string", enum: VIBES } }, required: ["vibe"] },
  },
];

const frontendHandlers: Record<string, (args: any) => string> = {
  ring_bell({ message }) {
    ding();
    confetti({ particleCount: 140, spread: 80, origin: { y: 0.35 } });
    const banner = $("banner");
    banner.innerHTML = `Order up!<small>${esc(message)}</small>`;
    banner.classList.add("show");
    setTimeout(() => banner.classList.remove("show"), 3200);
    return "bell rung, the dining room cheered";
  },
  set_kitchen_vibe({ vibe }) {
    if (!VIBES.includes(vibe)) return `error: vibe must be one of ${VIBES.join(", ")}`;
    document.documentElement.dataset.vibe = vibe;
    return `dining room is now ${vibe}`;
  },
};

function ding() {
  try {
    const ctx = new AudioContext();
    for (const [freq, at] of [[1568, 0], [2093, 0.09]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 1.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 1.2);
    }
  } catch {
    /* no audio, no problem */
  }
}

/* ---------- agent wiring ---------- */

const tap = new WireTap($("tap"), $("tapCount"), $<HTMLInputElement>("collapse"));
let agent: HttpAgent;
let busy = false;
let errorText = "";
let stopped = false;
/** Hand edits since the last run. Sent as RunAgentInput.context so the chef knows what you touched. */
let handEdits: string[] = [];
/** The tool call the agent is streaming right now, parsed from partial JSON: lets us show work before it lands in state. */
let draft: { name: string; args: Record<string, any> } | null = null;

const subscriber: AgentSubscriber = {
  onRunInitialized: ({ input }) => tap.outbound(input),
  onEvent: ({ event }) => {
    tap.inbound(event as BaseEvent);
    if (event.type === "CUSTOM" && (event as any).name === "kitchen.brain") $("brain").textContent = String((event as any).value);
  },
  onStepStartedEvent: ({ event }) => setStep(event.stepName.replaceAll("_", " ")),
  onToolCallArgsEvent: ({ toolCallName, partialToolCallArgs }) => {
    // The SDK repairs the half-streamed JSON for us; depending on version it hands back an object or a JSON string.
    let args: unknown = partialToolCallArgs;
    try {
      if (typeof args === "string") args = JSON.parse(args || "{}");
    } catch {
      args = {};
    }
    draft = { name: toolCallName, args: args && typeof args === "object" ? (args as Record<string, any>) : {} };
    renderTicket();
  },
  onToolCallEndEvent: () => void (draft = null),
  onMessagesChanged: () => renderChat(),
  onStateChanged: () => renderTicket(),
};

function newAgent() {
  agent = new HttpAgent({ url: "/agent", threadId: uid() });
  agent.subscribe(subscriber);
}

/**
 * One user action can take several runs: the agent may stop to let this tab
 * execute a frontend tool, and we send the result back in a follow-up run.
 */
async function run(params: Parameters<HttpAgent["runAgent"]>[0] = {}) {
  busy = true;
  stopped = false;
  errorText = "";
  renderAll();
  try {
    for (let hop = 0; hop < 5; hop++) {
      // Context: things about this dining room the agent can't know otherwise.
      const context = [
        { description: "Dining room vibe", value: document.documentElement.dataset.vibe ?? "diner" },
        ...(handEdits.length ? [{ description: "Edits the diner made to the ticket by hand since your last turn", value: handEdits.join("; ") }] : []),
      ];
      handEdits = [];
      await agent.runAgent({ tools: frontendTools, context, ...(hop === 0 ? params : {}) });
      if (agent.pendingInterrupts.length) break; // paused: waiting on the human

      const calls = unansweredFrontendCalls();
      if (!calls.length) break;
      for (const call of calls) {
        let content: string;
        try {
          content = frontendHandlers[call.function.name](JSON.parse(call.function.arguments || "{}"));
        } catch (err) {
          content = `error: ${err}`;
        }
        tap.local(`ran ${call.function.name} in the browser`, { toolCallId: call.id, content });
        agent.addMessage({ id: uid(), role: "tool", toolCallId: call.id, content });
      }
    }
  } catch (err) {
    if (!stopped) errorText = err instanceof Error ? err.message : String(err);
  }
  draft = null;
  busy = false;
  renderAll();
}

function unansweredFrontendCalls() {
  const answered = new Set(agent.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  return agent.messages
    .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
    .filter((c) => c.function.name in frontendHandlers && !answered.has(c.id));
}

function send(text: string) {
  if (busy || agent.pendingInterrupts.length || !text.trim()) return;
  agent.addMessage({ id: uid(), role: "user", content: text.trim() });
  void run();
}

/** Answer the interrupt: the paused run continues with our choice as its input. */
function resolveInterrupt(interrupt: Interrupt, choice: string | null) {
  if (busy) return;
  void run({
    resume: [choice ? { interruptId: interrupt.id, status: "resolved", payload: { choice } } : { interruptId: interrupt.id, status: "cancelled" }],
  });
}

/** The human edits shared state directly; it rides along in the next RunAgentInput. */
function editTicket(what: string, mutate: (t: Ticket) => void) {
  const next = structuredClone(agent.state as Ticket);
  mutate(next);
  agent.setState(next);
  handEdits.push(what);
  tap.local(`you edited the ticket: ${what}`, { note: "no request sent; rides along in the next RunAgentInput as state (the result) and context (what you changed)" });
  renderTicket();
}

/* ---------- rendering ---------- */

let stepLabel = "";
let served = false; // a finished brief has been on the table at least once
function setStep(label: string) {
  stepLabel = label;
  renderGuide();
}

const hasTicket = () => ((agent.state as Ticket)?.courses?.length ?? 0) > 0;

/** The guide answers three questions at all times: what is this for, where am I, whose move is it. */
function renderGuide() {
  const t = agent.state as Ticket;
  const waiting = agent.pendingInterrupts.length > 0;
  let stage: number; // index into STEPS
  let mine: boolean;
  let text: string;
  if (busy) {
    mine = false;
    stage = served ? 3 : t?.headlines?.length ? 2 : 1;
    text = served
      ? "Reworking the brief. Changes land on the ticket."
      : stage === 2
        ? "Finishing the brief with your headline."
        : "Writing your brief. Watch the ticket fill in, section by section.";
  } else if (waiting) {
    [stage, mine, text] = [2, true, "The chef has paused and needs you: pick a headline to finish the brief."];
  } else if (errorText) {
    [stage, mine, text] = [hasTicket() ? 3 : 0, true, "That run failed (details in the chat). Send your message again."];
  } else if (hasTicket()) {
    served = true;
    text = t.headlines.length && !t.chosenHeadline
      ? "The brief is ready but has no headline. Click one on the ticket, or ask the chef for new options."
      : "Your brief is ready. Copy it, edit the ticket by hand, or ask the chef for changes.";
    [stage, mine] = [3, true];
  } else {
    [stage, mine, text] = [0, true, "Pick a starter topic in the chat, or type your own. Optional: set the spice dial on the ticket first."];
  }
  const STEPS = ["Order a topic", "Chef writes the brief", "You pick the headline", "Refine and copy"];
  $("guide").innerHTML = `<ol class="steps">${STEPS.map(
    (label, i) => `<li class="${i < stage ? "done" : i === stage ? "active" : ""}"><span>${i < stage ? "✓" : i + 1}</span>${label}</li>`,
  ).join("")}</ol>
  <div class="now ${mine ? "you" : "chef"}"><b>${mine ? "Your turn" : "Chef's turn"}</b><span>${esc(text)}</span>${
    !mine && stepLabel ? `<em>${esc(stepLabel)}</em>` : ""
  }</div>`;
}

function renderAll() {
  renderChat();
  renderTicket();
  renderGuide();
  const waiting = agent.pendingInterrupts.length > 0;
  const input = $<HTMLInputElement>("orderInput");
  input.disabled = busy || waiting;
  input.placeholder = waiting ? "Pick a headline above first" : busy ? "Chef is working…" : hasTicket() ? "Ask for a change, e.g. “add a section on cost”" : "What should the article be about?";
  const submit = $("order").querySelector("button") as HTMLButtonElement;
  submit.disabled = waiting;
  submit.textContent = busy ? "Stop" : "Send";
  submit.classList.toggle("stop", busy);
  $("copy").hidden = !hasTicket();
  renderChips();
  $("chat").scrollTop = $("chat").scrollHeight; // chips changed the chat's height
  if (waiting) $("ticket").querySelector(".waiting")?.scrollIntoView({ block: "nearest" });
  if (!busy && !waiting) input.focus({ preventScroll: true });
}

function renderChips() {
  // Once there is a brief, the next steps come from the agent (the suggest_next tool writes them into shared state).
  const suggested = (agent.state as Ticket)?.suggestions ?? [];
  const [label, options] = hasTicket()
    ? suggested.length
      ? ["Chef suggests", suggested]
      : ["Try next", ["Make it spicier and redo the headlines", "Cut the weakest section", "Fine dining, please"]]
    : ["Start with one of these", ["Why your agent needs a UI protocol", "Vibe coding is technical debt on a timer", "MCP vs AG-UI vs A2A: who does what"]];
  $("chips").innerHTML =
    busy || agent.pendingInterrupts.length ? "" : `<span>${label}:</span>` + (options as string[]).map((o) => `<button type="button">${esc(o)}</button>`).join("");
}

function renderChat() {
  const chat = $("chat");
  const answered = new Set(agent.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  const text = (m: Message) => (typeof m.content === "string" ? m.content : "");
  const rows = agent.messages.map((m) => {
    if (m.role === "user") return `<div class="msg user">${esc(text(m))}</div>`;
    if (m.role === "reasoning") return `<div class="msg reasoning">${esc(text(m))}</div>`;
    if (m.role === "activity") return renderActivity(m.content as any);
    if (m.role !== "assistant") return "";
    const calls = (m.toolCalls ?? [])
      .map((c) => {
        const fe = c.function.name in frontendHandlers;
        return `<span class="call ${answered.has(c.id) ? "done" : "pending"} ${fe ? "frontend" : ""}" title="${fe ? "frontend tool: runs in your browser" : "server tool"}">${esc(c.function.name)}</span>`;
      })
      .join("");
    return (text(m) ? `<div class="msg assistant">${esc(text(m))}</div>` : "") + (calls ? `<div class="calls">${calls}</div>` : "");
  });
  // The paused run asks its question right where the conversation is.
  const interrupt = agent.pendingInterrupts[0];
  // The card is built from the interrupt alone: its message is the question, its responseSchema the allowed answers.
  if (interrupt && !busy)
    rows.push(`<div class="decision"><b>The chef needs a decision</b><p>${esc(interrupt.message ?? "Pick one to continue.")}</p>
      ${((interrupt.responseSchema as any)?.properties?.choice?.enum ?? []).map((h: string) => `<button type="button" class="headline" data-headline="${esc(h)}">${esc(h)}</button>`).join("")}
      <button type="button" class="sendback" data-sendback>None of these</button></div>`);
  if (errorText) rows.push(`<div class="msg error">RUN_ERROR · ${esc(errorText)}</div>`);
  chat.innerHTML =
    rows.join("") ||
    `<div class="empty"><b>Kitchen's open.</b>Tell the chef what the article is about. You'll get a brief on the ticket: an angle, an outline, a few hooks, and headline options to choose from.</div>`;
  chat.scrollTop = chat.scrollHeight;
}

/** ACTIVITY messages are structured, so they render as UI, not prose. */
function renderActivity(content: { title?: string; items?: { label: string; status: string; detail?: string }[] }) {
  const mark: Record<string, string> = { done: "✓", doing: "◐", you: "☞", todo: "○" };
  return `<div class="prep"><b>${esc(content.title ?? "Progress")}</b>${(content.items ?? [])
    .map((i) => `<div class="prep-item ${esc(i.status)}"><span>${mark[i.status] ?? "○"}</span>${esc(i.label)}${i.detail ? `<em>${esc(i.detail)}</em>` : ""}</div>`)
    .join("")}</div>`;
}

const SPICE = ["", "mild explainer", "warm", "medium", "hot take", "scorching"];
const seen = new Set<string>();
const fresh = (key: string) => (seen.has(key) ? "" : (seen.add(key), "fresh"));

function renderTicket() {
  const root = $("ticket");
  if (root.contains(document.activeElement) && (document.activeElement as HTMLElement).isContentEditable) return; // don't clobber an edit in progress
  const t = agent.state as Ticket;
  const interrupt = agent.pendingInterrupts[0];
  const penning = draft?.name === "set_ticket" ? draft.args : null; // topic and angle, as they are typed
  const started = !!t?.dish || hasTicket() || !!penning;
  const field = (label: string, value: string) =>
    `<div class="field"><span class="label">${label}</span><span>${value ? esc(value) : '<span class="blank">· · ·</span>'}</span></div>`;

  root.innerHTML = `<div class="ticket">
    <div class="ticket-head"><b>ARTICLE BRIEF</b><span>table 1 · thread ${esc(agent.threadId.slice(0, 8))}</span></div>
    ${field("Topic", penning?.dish ?? t?.dish)}${field("Angle", penning?.angle ?? t?.angle)}${field("Reader", penning?.audience ?? t?.audience)}
    <div class="field"><span class="label">Spice</span><span class="spice">
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-spice="${n}" class="${n <= (t?.spice ?? 3) ? "on" : ""}" aria-label="Spice ${n} of 5">🌶️</button>`).join("")}
      <em>${SPICE[t?.spice ?? 3]}</em></span></div>
    ${
      !started
        ? `<div class="ticket-empty"><p>The chef will fill this in:</p>
            <ol><li>Topic, angle and reader</li><li>An outline of 4 to 5 sections</li><li>A couple of hooks to quote</li><li>Headline options, and you pick one</li></ol>
            <p>The spice dial sets how bold the take is. It is yours to turn at any time.</p></div>`
        : `<div class="section-title"><span>Outline</span><span>${t.courses.length} section${t.courses.length === 1 ? "" : "s"}</span></div>
      ${t.courses
        .map(
          (c, i) => `<div class="course ${fresh(c.id)}">
            <span class="course-n">${i + 1}.</span>
            <span class="course-title" contenteditable="plaintext-only" spellcheck="false" title="Click to rename" data-course="${esc(c.id)}">${esc(c.title)}</span>
            <button class="x" type="button" data-remove="${esc(c.id)}" title="Remove this section" aria-label="Remove section">✕</button>
            <span class="course-note">${esc(c.note)}</span></div>`,
        )
        .join("")}
      ${
        draft?.name === "add_course" && (draft.args.title || draft.args.note)
          ? `<div class="course drafting"><span class="course-n">${t.courses.length + 1}.</span><span class="course-title">${esc(draft.args.title ?? "")}</span><span></span><span class="course-note">${esc(draft.args.note ?? "")}</span></div>`
          : ""
      }
      ${t.garnish.length ? `<div class="section-title"><span>Hooks</span></div>` : ""}
      ${t.garnish.map((g) => `<div class="garnish ${fresh("g:" + g)}">“${esc(g)}”</div>`).join("")}
      ${draft?.name === "add_garnish" && draft.args.text ? `<div class="garnish drafting">“${esc(draft.args.text)}</div>` : ""}
      ${
        draft?.name === "propose_headlines" && Array.isArray(draft.args.options)
          ? `<div class="section-title"><span>Headline</span><span>drafting</span></div>` + draft.args.options.map((h: unknown) => `<div class="headline drafting">${esc(h)}</div>`).join("")
          : ""
      }
      ${t.headlines.length && draft?.name !== "propose_headlines" ? `<div class="section-title"><span>Headline</span><span>${t.chosenHeadline ? "chosen" : "your pick"}</span></div>` : ""}
      ${interrupt ? `<div class="waiting">Paused for you. Pick the headline to finish the brief.</div>` : ""}
      ${(draft?.name === "propose_headlines" ? [] : t.headlines).map((h) => `<button type="button" class="headline ${h === t.chosenHeadline ? "chosen" : ""} ${fresh("h:" + h)}" data-headline="${esc(h)}">${esc(h)}</button>`).join("")}
      ${interrupt ? `<button type="button" class="sendback" data-sendback>None of these</button>` : ""}
      ${!interrupt && t.headlines.length && !t.chosenHeadline && !busy ? `<p class="hint">No headline chosen. Click one to pick it, or ask the chef for new ones.</p>` : ""}
      ${!busy && !interrupt ? `<p class="hint tips">This ticket is yours too: click a section title to rename it, ✕ to remove it, a headline to switch, or turn the spice dial. The chef sees your edits with your next message.</p>` : ""}`
    }
  </div>`;
  if (busy) root.scrollTop = root.scrollHeight; // follow the brief as it is written
}

function briefAsMarkdown(t: Ticket) {
  return [
    `# ${t.chosenHeadline ?? t.dish}`,
    "",
    `**Topic:** ${t.dish}`,
    `**Angle:** ${t.angle}`,
    `**Reader:** ${t.audience}`,
    `**Spice:** ${t.spice}/5 (${SPICE[t.spice]})`,
    "",
    "## Outline",
    ...t.courses.map((c, i) => `${i + 1}. **${c.title}**: ${c.note}`),
    ...(t.garnish.length ? ["", "## Hooks", ...t.garnish.map((g) => `- "${g}"`)] : []),
    ...(t.headlines.length ? ["", "## Headline options", ...t.headlines.map((h) => `- ${h}${h === t.chosenHeadline ? " (chosen)" : ""}`)] : []),
  ].join("\n");
}

/* ---------- events ---------- */

function onTicketAction(e: Event) {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spice],[data-remove],[data-headline],[data-sendback]");
  if (!el || busy) return;
  const interrupt = agent.pendingInterrupts[0];
  if (el.dataset.headline) {
    const h = el.dataset.headline;
    if (interrupt) resolveInterrupt(interrupt, h);
    else editTicket(`headline → "${h}"`, (t) => (t.chosenHeadline = h));
  } else if ("sendback" in el.dataset && interrupt) resolveInterrupt(interrupt, null);
  else if (el.dataset.spice) editTicket(`spice → ${el.dataset.spice}`, (t) => (t.spice = Number(el.dataset.spice)));
  else if (el.dataset.remove) editTicket("removed a section", (t) => (t.courses = t.courses.filter((c) => c.id !== el.dataset.remove)));
}
$("ticket").addEventListener("click", onTicketAction);
$("chat").addEventListener("click", onTicketAction); // the decision card in the chat

$("ticket").addEventListener("focusout", (e) => {
  const el = e.target as HTMLElement;
  const id = el.dataset?.course;
  if (!id) return;
  const title = el.textContent?.trim() ?? "";
  const current = (agent.state as Ticket).courses.find((c) => c.id === id);
  if (current && title && title !== current.title) editTicket(`retitled a section`, (t) => (t.courses.find((c) => c.id === id)!.title = title));
  else renderTicket();
});
$("ticket").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.target as HTMLElement).isContentEditable) (e.target as HTMLElement).blur();
});

$("copy").addEventListener("click", async () => {
  const button = $("copy");
  try {
    await navigator.clipboard.writeText(briefAsMarkdown(agent.state as Ticket));
    button.textContent = "Copied ✓";
  } catch {
    button.textContent = "Copy blocked by browser";
  }
  setTimeout(() => (button.textContent = "Copy brief"), 1800);
});

$("order").addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) {
    stopped = true;
    return agent.abortRun();
  }
  const input = $<HTMLInputElement>("orderInput");
  send(input.value);
  input.value = "";
});
$("chips").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b) send(b.textContent ?? "");
});
$("reset").addEventListener("click", () => {
  stopped = true;
  if (busy) agent.abortRun();
  busy = false;
  handEdits = [];
  draft = null;
  served = false;
  stepLabel = "";
  errorText = "";
  seen.clear();
  tap.clear();
  document.documentElement.dataset.vibe = "diner";
  newAgent();
  renderAll();
});

newAgent();
renderAll();
