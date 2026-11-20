/**
 * The Tribunal's courtroom. There is no chat here: the UI is a pitch form,
 * three judge cards, a rebuttal form and a stamp, all driven by one AG-UI
 * stream that carries three subagents at once.
 */
import { HttpAgent, type AgentSubscriber } from "@ag-ui/client";
import type { BaseEvent, Tool } from "@ag-ui/core";
import confetti from "canvas-confetti";
import { Lanes } from "./lanes";

interface Judge { name: string; title: string; emoji: string; score: number | null; prev: number | null; quip: string; take: string; reply: string }
interface Docket {
  pitch: string; round: number; rebuttal: string; order: string[];
  judges: Record<string, Judge>; verdict: { label: string; reason: string } | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const uid = () => crypto.randomUUID();
const docket = () => (agent.state ?? {}) as Partial<Docket>;

/* ---------- the one frontend tool: the Chair rules, the browser stamps ---------- */

const VERDICTS = ["SHIP IT", "NEEDS WORK", "BURN IT DOWN"];
const tools: Tool[] = [
  {
    name: "stamp_verdict",
    description: "Stamp the final verdict onto the pitch in the pitcher's browser.",
    parameters: {
      type: "object",
      properties: { verdict: { type: "string", enum: VERDICTS }, reason: { type: "string", description: "Max 12 words" } },
      required: ["verdict", "reason"],
    },
  },
];

function stampVerdict({ verdict, reason }: { verdict: string; reason: string }) {
  const label = VERDICTS.includes(verdict) ? verdict : "NEEDS WORK";
  agent.setState({ ...structuredClone(agent.state), verdict: { label, reason: String(reason ?? "") } });
  thud();
  if (label === "SHIP IT") confetti({ particleCount: 160, spread: 90, origin: { y: 0.3 } });
  if (label === "BURN IT DOWN") {
    document.body.classList.add("shake");
    setTimeout(() => document.body.classList.remove("shake"), 450);
  }
  return `stamped ${label}`;
}

function thud() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(140, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.25);
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch {
    /* silent courtroom */
  }
}

/* ---------- agent wiring ---------- */

const lanes = new Lanes($("lanes"), $("inspect"), $("wireCount"));
let agent: HttpAgent;
let busy = false;
let errorText = "";
let stepName = "";

/** Demultiplexing: which judge owns a subagent run, and which message. */
const judgeOfRun = new Map<string, string>();
const live = new Map<string, { judge: string | null; text: string }>(); // by messageId
const speaking = new Set<string>();
/** The newest streamed text per judge and round, so cards update per token instead of per state patch. */
const spoken: Record<string, string> = {};
let chairText = "";
let stamped = false;

const subscriber: AgentSubscriber = {
  onEvent: ({ event }) => {
    const e = event as BaseEvent & Record<string, any>;
    const judge = e.subagentRunId ? (judgeOfRun.get(e.subagentRunId) ?? null) : null;
    lanes.add(e, e.type === "SUBAGENT_STARTED" ? e.name : judge);
    if (e.type === "CUSTOM" && e.name === "tribunal.brain") $("brain").textContent = String(e.value);
  },
  onStepStartedEvent: ({ event }) => {
    stepName = event.stepName;
    renderGuide();
  },
  onSubagentStartedEvent: ({ event }) => {
    judgeOfRun.set(event.subagentRunId, event.name);
    speaking.add(event.name);
    paintJudge(event.name);
  },
  onSubagentFinishedEvent: ({ event }) => hush(event.subagentRunId),
  onSubagentErrorEvent: ({ event }) => hush(event.subagentRunId, event.message),
  onTextMessageStartEvent: ({ event }) => {
    const sub = (event as any).subagentRunId as string | undefined;
    live.set(event.messageId, { judge: sub ? (judgeOfRun.get(sub) ?? null) : null, text: "" });
  },
  onTextMessageContentEvent: ({ event }) => {
    const m = live.get(event.messageId);
    if (!m) return;
    m.text += event.delta;
    if (m.judge) {
      spoken[`${m.judge}:${docket().round ?? 1}`] = m.text;
      paintJudge(m.judge);
    } else {
      chairText = m.text;
      paintChair();
    }
  },
  onStateChanged: () => renderStage(),
};

function hush(subagentRunId: string, error?: string) {
  const judge = judgeOfRun.get(subagentRunId);
  if (!judge) return;
  speaking.delete(judge);
  if (error) spoken[`${judge}:${docket().round ?? 1}`] = `(left the bench: ${error})`;
  paintJudge(judge);
}

function newAgent() {
  agent = new HttpAgent({ url: "/tribunal-agent", threadId: uid() });
  agent.subscribe(subscriber);
}

async function run(params: Parameters<HttpAgent["runAgent"]>[0] = {}) {
  busy = true;
  errorText = "";
  lanes.resume();
  renderAll();
  try {
    await agent.runAgent({ tools, ...params });
    // The run ends with the Chair's stamp call unanswered: it is ours to execute.
    if (!agent.pendingInterrupts.length) {
      const answered = new Set(agent.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
      for (const m of agent.messages)
        for (const call of (m.role === "assistant" && m.toolCalls) || [])
          if (call.function.name === "stamp_verdict" && !answered.has(call.id)) {
            let content: string;
            try {
              content = stampVerdict(JSON.parse(call.function.arguments || "{}"));
            } catch (err) {
              content = `error: ${err}`;
            }
            agent.addMessage({ id: uid(), role: "tool", toolCallId: call.id, content });
          }
    }
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
  }
  busy = false;
  speaking.clear();
  if (agent.pendingInterrupts.length) lanes.pause();
  renderAll();
}

function pitch(text: string) {
  if (busy || !text.trim()) return;
  agent.addMessage({ id: uid(), role: "user", content: text.trim() });
  void run();
}

/* ---------- rendering ---------- */

function renderAll() {
  renderGuide();
  renderBench();
  renderStage();
}

function renderGuide() {
  const d = docket();
  const waiting = agent.pendingInterrupts.length > 0;
  let stage: number, mine: boolean, text: string;
  if (errorText) [stage, mine, text] = [d.pitch ? 1 : 0, true, "That run failed (details below). Start a new pitch."];
  else if (busy && stepName === "verdict") [stage, mine, text] = [3, false, "The Chair is ruling."];
  else if (busy && (d.round ?? 0) >= 2) [stage, mine, text] = [2, false, "The judges are weighing your rebuttal. Watch the scores."];
  else if (busy) [stage, mine, text] = [1, false, "All three judges are reacting at the same time. Scores land as each one finishes."];
  else if (waiting) [stage, mine, text] = [2, true, "Argue back. A good rebuttal moves the scores, and the average decides the verdict. Or skip straight to the ruling."];
  else if (d.verdict) [stage, mine, text] = [4, true, `The verdict is in: ${d.verdict.label}. Try another pitch?`];
  else [stage, mine, text] = [0, true, "Pitch an idea, a hot take or an architecture decision. Three judges will score it out of 10."];

  const STEPS = ["Make your pitch", "The panel reacts", "Your rebuttal", "The verdict"];
  $("guide").innerHTML = `<ol class="steps">${STEPS.map(
    (label, i) => `<li class="${i < stage ? "done" : i === stage ? "active" : ""}"><span>${i < stage ? "✓" : i + 1}</span>${label}</li>`,
  ).join("")}</ol>
  <div class="now ${mine ? "you" : "them"}"><b>${mine ? "Your turn" : "The bench"}</b><span>${esc(text)}</span></div>`;
}

/** Top of the page: the pitch form, then the pitch itself, then whatever the agent is asking for. */
function renderBench() {
  const d = docket();
  const interrupt = agent.pendingInterrupts[0];
  let html = "";
  if (!d.pitch && !busy) {
    html = `<form class="card ask" data-pitch>
      <h2>State your case</h2><p class="help">One or two sentences. The spicier the better.</p>
      <div class="row"><input name="pitch" maxlength="400" autocomplete="off" placeholder="e.g. We should rewrite the whole backend in Rust" aria-label="Your pitch" /><button class="btn">Pitch it</button></div>
      <div class="chips">Or try: ${["Microservices for my 3-user todo app", "Replace our entire QA team with one LLM prompt", "A standard protocol between AI agents and frontends", "Deploy on Fridays to build character"]
        .map((c) => `<button type="button" data-chip>${esc(c)}</button>`)
        .join("")}</div></form>`;
  } else {
    const pitchText = d.pitch || agent.messages.findLast((m) => m.role === "user")?.content;
    const v = d.verdict;
    html = `<div class="card exhibit"><div><small>Exhibit A · the pitch</small><blockquote>“${esc(pitchText)}”</blockquote>
      ${d.rebuttal ? `<div class="rebut"><small>Your rebuttal</small><blockquote>“${esc(d.rebuttal)}”</blockquote></div>` : ""}</div>
      ${v ? `<div class="stamp ${v.label === "SHIP IT" ? "ship" : v.label === "BURN IT DOWN" ? "burn" : ""} ${stamped ? "" : "slam"}">${esc(v.label)}<small>${esc(v.reason)}</small></div>` : ""}</div>`;
    if (v) stamped = true; // slam once, not on every re-render
  }
  // The rebuttal form is generated from the interrupt: one field per property in its responseSchema.
  if (interrupt && !busy) {
    const props = ((interrupt.responseSchema as any)?.properties ?? {}) as Record<string, { title?: string; description?: string; maxLength?: number }>;
    html += `<form class="card ask" data-resume>
      <h2>${esc(Object.values(props)[0]?.title ?? "Your response")}</h2><p class="help">${esc(interrupt.message ?? "")}</p>
      ${Object.entries(props)
        .map(([key, p]) => `<textarea name="${esc(key)}" ${p.maxLength ? `maxlength="${p.maxLength}"` : ""} placeholder="${esc(p.description ?? "")}" aria-label="${esc(p.title ?? key)}" required></textarea>`)
        .join("")}
      <div class="row"><button class="btn">Submit rebuttal</button><button class="btn quiet" type="button" data-skip>No rebuttal, just rule</button><span class="count"></span></div></form>`;
  }
  if (errorText) html += `<div class="error">RUN_ERROR · ${esc(errorText)}</div>`;
  $("bench").innerHTML = html;
  $("bench").querySelector<HTMLElement>("input,textarea")?.focus({ preventScroll: true });
}

/** Judges, gauge and Chair. Cards are built once, then painted in place so animations survive token updates. */
function renderStage() {
  const d = docket();
  const root = $("judges");
  const order = d.order ?? [];
  if (!order.length) {
    root.dataset.built = "";
    root.innerHTML = ["An on-call SRE", "A venture capitalist", "A staff engineer"].map((who) => `<div class="judge ghost">${who}<br/>takes a seat when you pitch.</div>`).join("");
  } else if (root.dataset.built !== agent.threadId) {
    root.dataset.built = agent.threadId;
    root.innerHTML = order
      .map((id) => {
        const j = d.judges![id];
        return `<article class="judge" id="judge-${id}">
          <div class="who"><div class="avatar">${esc(j.emoji)}</div><div><b>${esc(j.name)}</b><small>${esc(j.title)}</small></div>
            <div class="card-score"><div class="ring"><span>–</span></div><div class="delta"></div></div></div>
          <div class="quip"></div><p class="say take"></p><p class="say reply"></p><div class="status"></div></article>`;
      })
      .join("");
  }
  order.forEach(paintJudge);
  paintGauge();
  paintChair();
  renderGuide();
  // the stamp lives on the exhibit card
  if (d.verdict && !$("bench").querySelector(".stamp")) renderBench();
}

const tone = (score: number) => (score >= 7 ? "var(--good)" : score >= 4.5 ? "var(--mid)" : "var(--bad)");

function paintJudge(id: string) {
  const el = document.getElementById(`judge-${id}`);
  const j = docket().judges?.[id];
  if (!el || !j) return;
  const round = docket().round ?? 1;
  const isSpeaking = speaking.has(id);
  el.classList.toggle("speaking", isSpeaking);
  const take = el.querySelector<HTMLElement>(".take")!;
  const reply = el.querySelector<HTMLElement>(".reply")!;
  take.textContent = j.take || spoken[`${id}:1`] || "";
  reply.textContent = j.reply || spoken[`${id}:2`] || "";
  take.classList.toggle("live", isSpeaking && round === 1);
  reply.classList.toggle("live", isSpeaking && round === 2);
  el.querySelector<HTMLElement>(".quip")!.textContent = j.quip ? `“${j.quip}”` : "";
  el.querySelector<HTMLElement>(".status")!.textContent = isSpeaking ? (round === 2 ? "responding to you…" : "speaking…") : "";

  const ring = el.querySelector<HTMLElement>(".ring")!;
  const shown = ring.dataset.score ?? "";
  if (String(j.score ?? "") !== shown) {
    ring.dataset.score = String(j.score ?? "");
    ring.querySelector("span")!.textContent = j.score == null ? "–" : String(j.score);
    ring.style.setProperty("--p", String(j.score ?? 0));
    ring.style.setProperty("--rc", j.score == null ? "var(--line)" : tone(j.score));
    ring.classList.remove("pop");
    void ring.offsetWidth; // restart the animation
    if (j.score != null) ring.classList.add("pop");
  }
  const delta = el.querySelector<HTMLElement>(".delta")!;
  const settled = round === 2 && j.prev != null && j.score != null && (!isSpeaking || j.reply);
  const diff = settled ? j.score! - j.prev! : 0;
  delta.textContent = !settled ? "" : diff > 0 ? `▲ +${diff}` : diff < 0 ? `▼ ${diff}` : "held";
  delta.className = `delta ${diff > 0 ? "up" : diff < 0 ? "down" : "hold"}`;
}

function paintGauge() {
  const d = docket();
  const scores = (d.order ?? []).map((id) => d.judges![id].score).filter((s): s is number => s != null);
  const gauge = $("gauge");
  gauge.classList.toggle("on", scores.length > 0);
  if (!scores.length) return;
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (!gauge.firstChild)
    gauge.innerHTML = `<div class="gauge-top"><span>Panel average decides the verdict</span><b></b></div>
      <div class="track"><div class="needle"></div></div>
      <div class="zones"><span>BURN IT DOWN</span><span>NEEDS WORK</span><span>SHIP IT (7+)</span></div>`;
  gauge.querySelector("b")!.textContent = `${avg.toFixed(1)} / 10${scores.length < (d.order?.length ?? 3) ? ` (${scores.length} of ${d.order!.length} in)` : ""}`;
  gauge.querySelector<HTMLElement>(".needle")!.style.left = `calc(${((avg - 1) / 9) * 100}% - 2px)`;
}

function paintChair() {
  const chair = $("chair");
  chair.hidden = !chairText;
  if (!chairText) return;
  if (!chair.firstChild) chair.innerHTML = `<small>⚖️ The Chair</small><p></p>`;
  chair.querySelector("p")!.textContent = chairText;
}

/* ---------- events ---------- */

function reset() {
  if (busy) agent.abortRun();
  busy = false;
  errorText = "";
  stepName = "";
  chairText = "";
  stamped = false;
  judgeOfRun.clear();
  live.clear();
  speaking.clear();
  for (const k of Object.keys(spoken)) delete spoken[k];
  $("gauge").innerHTML = "";
  $("chair").innerHTML = "";
  lanes.clear();
  newAgent();
  renderAll();
}

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  if ("pitch" in form.dataset) pitch(new FormData(form).get("pitch") as string);
  else if ("resume" in form.dataset && !busy) {
    // Answer the interrupt with a payload shaped by its own schema.
    const payload = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
    void run({ resume: [{ interruptId: agent.pendingInterrupts[0].id, status: "resolved", payload }] });
  }
});
document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-chip],[data-skip],[data-reset]");
  if (!el) return;
  if ("chip" in el.dataset) pitch(el.textContent ?? "");
  else if ("skip" in el.dataset && !busy) void run({ resume: [{ interruptId: agent.pendingInterrupts[0].id, status: "cancelled" }] });
  else if ("reset" in el.dataset) reset();
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLTextAreaElement;
  const count = el.form?.querySelector(".count");
  if (count && el.maxLength > 0) count.textContent = `${el.value.length} / ${el.maxLength}`;
});

newAgent();
renderAll();
