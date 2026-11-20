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
  courses: Course[]; garnish: string[]; headlines: string[]; chosenHeadline: string | null;
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

const subscriber: AgentSubscriber = {
  onRunInitialized: ({ input }) => tap.outbound(input),
  onEvent: ({ event }) => {
    tap.inbound(event as BaseEvent);
    if (event.type === "CUSTOM" && (event as any).name === "kitchen.brain") $("brain").textContent = String((event as any).value);
  },
  onStepStartedEvent: ({ event }) => setStep(event.stepName.replaceAll("_", " "), true),
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
  errorText = "";
  renderAll();
  try {
    for (let hop = 0; hop < 5; hop++) {
      await agent.runAgent({ tools: frontendTools, ...(hop === 0 ? params : {}) });
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
    errorText = err instanceof Error ? err.message : String(err);
  }
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
  tap.local(`you edited the ticket: ${what}`, { note: "no request sent; the agent sees it in the next RunAgentInput.state" });
  renderTicket();
}

/* ---------- rendering ---------- */

function setStep(label: string, live: boolean) {
  const el = $("step");
  el.textContent = label;
  el.classList.toggle("live", live);
}

function renderAll() {
  renderChat();
  renderTicket();
  const waiting = agent.pendingInterrupts.length > 0;
  if (!busy) setStep(waiting ? "waiting on you" : "idle", waiting);
  const input = $<HTMLInputElement>("orderInput");
  input.disabled = busy || waiting;
  input.placeholder = waiting ? "Chef is waiting on your headline pick →" : busy ? "Chef is cooking…" : hasTicket() ? "Ask for changes…" : "Order an article topic…";
  ($("order").querySelector("button") as HTMLButtonElement).disabled = busy || waiting;
  renderChips();
  $("chat").scrollTop = $("chat").scrollHeight; // chips changed the chat's height
  if (!busy && !waiting) input.focus({ preventScroll: true });
}

const hasTicket = () => ((agent.state as Ticket)?.courses?.length ?? 0) > 0;

function renderChips() {
  const options = hasTicket()
    ? ["Make it spicier and re-fire the headlines", "86 the weakest course", "Fine dining, please", "Food truck vibes"]
    : ["Cook: why your agent needs a UI protocol", "Cook: vibe coding is technical debt on a timer", "Cook: MCP vs AG-UI vs A2A, who does what"];
  $("chips").innerHTML = busy || agent.pendingInterrupts.length ? "" : options.map((o) => `<button type="button">${esc(o)}</button>`).join("");
}

function renderChat() {
  const chat = $("chat");
  const answered = new Set(agent.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  const text = (m: Message) => (typeof m.content === "string" ? m.content : "");
  const rows = agent.messages.map((m) => {
    if (m.role === "user") return `<div class="msg user">${esc(text(m))}</div>`;
    if (m.role === "reasoning") return `<div class="msg reasoning">${esc(text(m))}</div>`;
    if (m.role !== "assistant") return "";
    const calls = (m.toolCalls ?? [])
      .map((c) => {
        const fe = c.function.name in frontendHandlers;
        return `<span class="call ${answered.has(c.id) ? "done" : "pending"} ${fe ? "frontend" : ""}" title="${fe ? "frontend tool: runs in your browser" : "server tool"}">${esc(c.function.name)}</span>`;
      })
      .join("");
    return (text(m) ? `<div class="msg assistant">${esc(text(m))}</div>` : "") + (calls ? `<div class="calls">${calls}</div>` : "");
  });
  if (errorText) rows.push(`<div class="msg error">RUN_ERROR · ${esc(errorText)}</div>`);
  chat.innerHTML =
    rows.join("") ||
    `<div class="empty"><b>Kitchen's open.</b>Name a topic and the chef will cook an article brief on the ticket, live. Watch the wire tap to see the protocol do it.</div>`;
  chat.scrollTop = chat.scrollHeight;
}

const SPICE = ["", "mild explainer", "warm", "medium", "hot take", "scorching"];
const seen = new Set<string>();
const fresh = (key: string) => (seen.has(key) ? "" : (seen.add(key), "fresh"));

function renderTicket() {
  const root = $("ticket");
  if (root.contains(document.activeElement) && (document.activeElement as HTMLElement).isContentEditable) return; // don't clobber an edit in progress
  const t = agent.state as Ticket;
  const interrupt = agent.pendingInterrupts[0];
  const started = !!t?.dish || hasTicket();
  const field = (label: string, value: string) =>
    `<div class="field"><span class="label">${label}</span><span>${value ? esc(value) : '<span class="blank">· · ·</span>'}</span></div>`;

  root.innerHTML = `<div class="ticket">
    <div class="ticket-head"><b>ORDER TICKET</b><span>table 1 · thread ${esc(agent.threadId.slice(0, 8))}</span></div>
    ${field("Dish", t?.dish)}${field("Angle", t?.angle)}${field("For", t?.audience)}
    <div class="field"><span class="label">Spice</span><span class="spice">
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-spice="${n}" class="${n <= (t?.spice ?? 3) ? "on" : ""}" aria-label="Spice ${n} of 5">🌶️</button>`).join("")}
      <em>${SPICE[t?.spice ?? 3]}</em></span></div>
    ${
      !started
        ? `<div class="ticket-empty">Nothing on the rail yet.<br/>Set the spice, then order.</div>`
        : `<div class="section-title"><span>Courses</span><span>${t.courses.length}</span></div>
      ${t.courses
        .map(
          (c, i) => `<div class="course ${fresh(c.id)}">
            <span class="course-n">${i + 1}.</span>
            <span class="course-title" contenteditable="plaintext-only" spellcheck="false" data-course="${esc(c.id)}">${esc(c.title)}</span>
            <button class="x" type="button" data-remove="${esc(c.id)}" aria-label="Remove course">✕</button>
            <span class="course-note">${esc(c.note)}</span></div>`,
        )
        .join("")}
      ${t.garnish.length ? `<div class="section-title"><span>Garnish</span></div>` : ""}
      ${t.garnish.map((g) => `<div class="garnish ${fresh("g:" + g)}">“${esc(g)}”</div>`).join("")}
      ${t.headlines.length ? `<div class="section-title"><span>Headline</span></div>` : ""}
      ${interrupt ? `<div class="waiting">Kitchen is paused. ${esc(interrupt.message ?? "Pick one.")}</div>` : ""}
      ${t.headlines.map((h) => `<button type="button" class="headline ${h === t.chosenHeadline ? "chosen" : ""} ${fresh("h:" + h)}" data-headline="${esc(h)}">${esc(h)}</button>`).join("")}
      ${interrupt ? `<button type="button" class="sendback" data-sendback>none of these, send it back</button>` : ""}`
    }
  </div>`;
}

/* ---------- events ---------- */

$("ticket").addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-spice],[data-remove],[data-headline],[data-sendback]");
  if (!el || busy) return;
  const interrupt = agent.pendingInterrupts[0];
  if (el.dataset.headline) {
    const h = el.dataset.headline;
    if (interrupt) resolveInterrupt(interrupt, h);
    else editTicket(`headline → "${h}"`, (t) => (t.chosenHeadline = h));
  } else if ("sendback" in el.dataset && interrupt) resolveInterrupt(interrupt, null);
  else if (el.dataset.spice) editTicket(`spice → ${el.dataset.spice}`, (t) => (t.spice = Number(el.dataset.spice)));
  else if (el.dataset.remove) editTicket("removed a course", (t) => (t.courses = t.courses.filter((c) => c.id !== el.dataset.remove)));
});

$("ticket").addEventListener("focusout", (e) => {
  const el = e.target as HTMLElement;
  const id = el.dataset?.course;
  if (!id) return;
  const title = el.textContent?.trim() ?? "";
  const current = (agent.state as Ticket).courses.find((c) => c.id === id);
  if (current && title && title !== current.title) editTicket(`retitled a course`, (t) => (t.courses.find((c) => c.id === id)!.title = title));
  else renderTicket();
});
$("ticket").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.target as HTMLElement).isContentEditable) (e.target as HTMLElement).blur();
});

$("order").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("orderInput");
  send(input.value);
  input.value = "";
});
$("chips").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b) send(b.textContent ?? "");
});
$("reset").addEventListener("click", () => {
  if (busy) agent.abortRun();
  busy = false;
  errorText = "";
  seen.clear();
  tap.clear();
  newAgent();
  renderAll();
});

newAgent();
renderAll();
