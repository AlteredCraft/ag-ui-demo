/**
 * The wire tap: a live log of every AG-UI event the agent streams, plus the
 * RunAgentInput we POST. Click any row for the raw JSON.
 */
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** High-frequency events that fold into one row per stream. */
const STREAMED = new Set(["TEXT_MESSAGE_CONTENT", "REASONING_MESSAGE_CONTENT", "TOOL_CALL_ARGS"]);

function family(type: string) {
  if (type.startsWith("RUN_") || type.startsWith("STEP_")) return "life";
  if (type.startsWith("TEXT_")) return "text";
  if (type.startsWith("TOOL_")) return "tool";
  if (type.startsWith("STATE_") || type.startsWith("MESSAGES_")) return "state";
  if (type.startsWith("REASONING_")) return "reason";
  if (type.startsWith("ACTIVITY_")) return "act";
  return "misc";
}

function summarize(e: any): string {
  switch (e.type) {
    case "RUN_STARTED": return `run ${e.runId.slice(0, 8)}`;
    case "RUN_FINISHED": return e.outcome?.type === "interrupt" ? `outcome: interrupt (${e.outcome.interrupts[0]?.reason})` : `outcome: ${e.outcome?.type ?? "success"}`;
    case "RUN_ERROR": return e.message;
    case "STEP_STARTED": case "STEP_FINISHED": return e.stepName;
    case "TOOL_CALL_START": return e.toolCallName;
    case "TOOL_CALL_RESULT": return e.content;
    case "STATE_SNAPSHOT": return `${Object.keys(e.snapshot ?? {}).length} keys`;
    case "STATE_DELTA": return e.delta.map((op: any) => `${op.op} ${op.path}`).join(", ");
    case "ACTIVITY_SNAPSHOT": return `${e.activityType} · ${e.content?.items?.length ?? 0} items`;
    case "ACTIVITY_DELTA": return e.patch.map((op: any) => `${op.path} = ${op.value}`).join(", ");
    case "MESSAGES_SNAPSHOT": return `${e.messages.length} messages`;
    case "CUSTOM": return `${e.name} = ${JSON.stringify(e.value)}`;
    default: return "";
  }
}

export class WireTap {
  private count = 0;
  private t0 = performance.now();
  private fold: { key: string; n: number; text: string; sum: HTMLElement; pre: HTMLElement } | null = null;

  constructor(private log: HTMLElement, private counter: HTMLElement, private collapse: HTMLInputElement) {
    this.clear();
  }

  clear() {
    this.count = 0;
    this.fold = null;
    this.counter.textContent = "0 events";
    this.log.innerHTML = `<div class="tap-empty">Nothing on the wire yet. Every event the agent streams shows up here, in order.</div>`;
  }

  outbound(input: RunAgentInput) {
    this.t0 = performance.now();
    const bits = [`${input.messages.length} msgs`, `${input.tools?.length ?? 0} tools`, input.state ? "state" : "", input.context?.length ? `${input.context.length} context` : "", input.resume?.length ? `resume ×${input.resume.length}` : ""];
    this.row("out", "▲ POST /agent", `RunAgentInput · ${bits.filter(Boolean).join(" · ")}`, input);
  }

  local(summary: string, detail: unknown) {
    this.row("local", "● LOCAL", summary, detail);
  }

  inbound(e: BaseEvent) {
    this.counter.textContent = `${++this.count} events`;
    const any = e as any;
    if (this.collapse.checked && STREAMED.has(e.type)) {
      const key = e.type + (any.messageId ?? any.toolCallId);
      if (this.fold?.key === key) {
        this.fold.n++;
        this.fold.text += any.delta;
        this.fold.sum.textContent = `×${this.fold.n}  ${this.fold.text}`;
        this.fold.pre.textContent = `${this.fold.n} events, deltas concatenated:\n${this.fold.text}`;
        this.stick();
        return;
      }
      const { sum, pre } = this.row(family(e.type), e.type, `×1  ${any.delta}`, e);
      this.fold = { key, n: 1, text: any.delta, sum, pre };
      return;
    }
    this.row(family(e.type), e.type, summarize(any), e);
  }

  private row(cls: string, type: string, summary: string, detail: unknown) {
    this.log.querySelector(".tap-empty")?.remove();
    this.fold = null;
    const el = document.createElement("details");
    el.className = `ev ${cls}`;
    const dt = ((performance.now() - this.t0) / 1000).toFixed(2);
    el.innerHTML = `<summary><time>+${dt}s</time><span class="type">${esc(type)}</span><span class="sum">${esc(summary)}</span></summary><pre></pre>`;
    const pre = el.querySelector("pre")!;
    pre.textContent = JSON.stringify(detail, null, 2);
    this.log.append(el);
    this.stick();
    return { sum: el.querySelector<HTMLElement>(".sum")!, pre };
  }

  private stick() {
    this.log.scrollTop = this.log.scrollHeight;
  }
}
