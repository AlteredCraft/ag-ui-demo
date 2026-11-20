/**
 * Draws the event stream as swim lanes: one lane for the main run, one per
 * subagent. Time runs left to right. All of it arrived on one connection.
 */
import type { BaseEvent } from "@ag-ui/core";

const PX_PER_SECOND = 70;
const MAIN = "chair";

function kind(type: string) {
  if (type.startsWith("SUBAGENT_")) return "sub";
  if (type.startsWith("RUN_") || type.startsWith("STEP_")) return "life";
  if (type.startsWith("TEXT_")) return "text";
  if (type.startsWith("TOOL_")) return "tool";
  if (type.startsWith("STATE_") || type.startsWith("MESSAGES_")) return "state";
  return "misc";
}

export class Lanes {
  private tracks = new Map<string, HTMLElement>();
  private count = 0;
  private clock = 0; // seconds of streaming so far; frozen while waiting on the human
  private runStart = performance.now();
  private selected: HTMLElement | null = null;
  private legend: HTMLElement | null = null;

  constructor(private root: HTMLElement, private inspect: HTMLElement, private counter: HTMLElement) {}

  clear() {
    this.root.innerHTML = "";
    this.tracks.clear();
    this.count = 0;
    this.clock = 0;
    this.legend?.remove();
    this.legend = null;
    this.inspect.hidden = true;
    this.counter.textContent = "Every tick is one AG-UI event on the same connection, sorted into lanes by its subagentRunId. Click a tick to read it.";
  }

  /** A new run begins: continue the time axis where the last one stopped. */
  resume() {
    this.runStart = performance.now() - this.clock * 1000;
  }

  /** The run ended on an interrupt: mark the gap. */
  pause() {
    this.clock = this.now() + 0.4;
    for (const track of this.tracks.values()) {
      const mark = document.createElement("div");
      mark.className = "pause";
      mark.style.left = `${this.clock * PX_PER_SECOND - 14}px`;
      if (track !== this.tracks.get(MAIN)) mark.classList.add("bare");
      track.append(mark);
    }
    this.clock += 1.6;
  }

  add(event: BaseEvent, judge: string | null) {
    const t = this.now();
    this.clock = t;
    const track = this.track(judge ?? MAIN);
    const tick = document.createElement("i");
    const k = kind(event.type);
    tick.className = `tick k-${k}${k === "sub" || k === "life" || event.type === "TOOL_CALL_START" ? " big" : ""}`;
    tick.style.left = `${t * PX_PER_SECOND}px`;
    tick.title = event.type;
    tick.addEventListener("click", () => {
      this.selected?.classList.remove("sel");
      this.selected = tick;
      tick.classList.add("sel");
      this.inspect.hidden = false;
      this.inspect.textContent = JSON.stringify(event, null, 2);
    });
    track.append(tick);
    const width = `${t * PX_PER_SECOND + 120}px`;
    for (const tr of this.tracks.values()) tr.style.width = width;
    this.root.scrollLeft = this.root.scrollWidth;
    this.counter.textContent = `${++this.count} AG-UI events so far, all on one connection per run, sorted into lanes by subagentRunId. Click a tick to read it.`;
  }

  private now() {
    return (performance.now() - this.runStart) / 1000;
  }

  private track(name: string) {
    let track = this.tracks.get(name);
    if (track) return track;
    const lane = document.createElement("div");
    lane.className = "lane";
    lane.innerHTML = `<span class="lane-name"></span><div class="lane-track"></div>`;
    lane.querySelector(".lane-name")!.textContent = name === MAIN ? "main run" : `sub: ${name}`;
    track = lane.querySelector<HTMLElement>(".lane-track")!;
    this.root.append(lane);
    this.tracks.set(name, track);
    if (!this.legend) {
      this.legend = document.createElement("div");
      this.legend.className = "legend";
      this.legend.innerHTML = [["life", "run / step"], ["sub", "subagent start / finish"], ["text", "text"], ["tool", "tool call"], ["state", "state"]]
        .map(([k, label]) => `<span class="k-${k}"><i></i>${label}</span>`)
        .join("");
      this.root.after(this.legend);
    }
    return track;
  }
}
