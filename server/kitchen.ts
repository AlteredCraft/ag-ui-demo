/**
 * The kitchen's domain: the shared "ticket" (an article brief), the tools the
 * chef can use on it, and the JSON Patch each tool produces.
 *
 * Every mutation returns RFC 6902 ops so the server can ship them as a
 * STATE_DELTA instead of re-sending the whole ticket.
 */

export interface Course {
  id: string;
  title: string;
  note: string;
}

export interface Ticket {
  dish: string; // working topic
  angle: string; // the take
  audience: string; // who it's for
  spice: number; // 1 (mild explainer) .. 5 (scorching hot take)
  courses: Course[]; // outline sections
  garnish: string[]; // hooks, pull quotes, one-liners
  headlines: string[]; // options the chef proposed
  chosenHeadline: string | null;
  suggestions: string[]; // what the chef thinks the diner might ask next
}

export type PatchOp =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export const emptyTicket = (): Ticket => ({
  dish: "",
  angle: "",
  audience: "",
  spice: 3,
  courses: [],
  garnish: [],
  headlines: [],
  chosenHeadline: null,
  suggestions: [],
});

/** Client state is untrusted input: coerce it into a well-formed ticket. */
export function normalizeTicket(raw: unknown): Ticket {
  const t = emptyTicket();
  if (!raw || typeof raw !== "object") return t;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");
  t.dish = str(r.dish);
  t.angle = str(r.angle);
  t.audience = str(r.audience);
  if (typeof r.spice === "number") t.spice = Math.min(5, Math.max(1, Math.round(r.spice)));
  if (Array.isArray(r.courses))
    t.courses = r.courses.slice(0, 12).flatMap((c) =>
      c && typeof c === "object" && typeof (c as Course).id === "string"
        ? [{ id: str((c as Course).id, 40), title: str((c as Course).title), note: str((c as Course).note, 800) }]
        : [],
    );
  if (Array.isArray(r.garnish)) t.garnish = r.garnish.slice(0, 8).map((g) => str(g)).filter(Boolean);
  if (Array.isArray(r.headlines)) t.headlines = r.headlines.slice(0, 6).map((h) => str(h)).filter(Boolean);
  t.chosenHeadline = typeof r.chosenHeadline === "string" ? str(r.chosenHeadline) : null;
  if (Array.isArray(r.suggestions)) t.suggestions = r.suggestions.slice(0, 4).map((x) => str(x, 80)).filter(Boolean);
  return t;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const s = (description: string) => ({ type: "string", description });

/** The one tool that pauses the run and hands control to the human. */
export const HEADLINE_TOOL = "propose_headlines";
/** Ends a turn on its own: there is nothing for the model to say after it. */
export const SUGGEST_TOOL = "suggest_next";

export const serverTools: ToolDef[] = [
  {
    name: "set_ticket",
    description: "Write the top of the ticket: the dish (topic), the angle (the take), and who it is for.",
    parameters: obj(
      { dish: s("Topic, 3-8 words"), angle: s("The specific take, one sentence"), audience: s("Who this is for, a short phrase") },
      ["dish", "angle", "audience"],
    ),
  },
  {
    name: "set_spice",
    description: "Turn the spice dial when the diner asks for a hotter or milder take. Then rewrite the angle and sections to match.",
    parameters: obj({ level: { type: "integer", minimum: 1, maximum: 5 } }, ["level"]),
  },
  {
    name: "add_course",
    description: "Add one section to the outline. Call once per section, in reading order.",
    parameters: obj(
      { title: s("Section title, punchy"), note: s("One or two sentences: what this section argues or shows") },
      ["title", "note"],
    ),
  },
  {
    name: "update_course",
    description: "Rewrite an existing section by id.",
    parameters: obj({ id: s("Course id from the ticket"), title: s("New title"), note: s("New note") }, ["id", "title", "note"]),
  },
  {
    name: "remove_course",
    description: "Take a section off the ticket by id.",
    parameters: obj({ id: s("Course id from the ticket") }, ["id"]),
  },
  {
    name: "add_garnish",
    description: "Add a hook, pull quote, or memorable one-liner the writer can use.",
    parameters: obj({ text: s("The line itself") }, ["text"]),
  },
  {
    name: HEADLINE_TOOL,
    description:
      "Put 3-4 headline options in front of the diner and WAIT for them to pick. The run pauses until they answer. Call it alone, as the last tool in a turn.",
    parameters: obj({ options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 } }, ["options"]),
  },
  {
    name: SUGGEST_TOOL,
    description:
      "Show the diner 3 tappable follow-up requests, specific to this ticket, phrased the way the diner would type them (max 7 words each). Replaces the previous suggestions.",
    parameters: obj({ options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 } }, ["options"]),
  },
];

let seq = 0;
const courseId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Runs a server tool against the ticket. Mutates `t`, and returns the patch
 * that describes the mutation plus the string the model gets back.
 */
export function runServerTool(t: Ticket, name: string, args: Record<string, any>): { ops: PatchOp[]; result: string } {
  switch (name) {
    case "set_ticket": {
      const ops: PatchOp[] = [];
      for (const k of ["dish", "angle", "audience"] as const) {
        if (typeof args[k] === "string") {
          t[k] = args[k];
          ops.push({ op: "replace", path: `/${k}`, value: args[k] });
        }
      }
      return { ops, result: "ticket written" };
    }
    case "set_spice": {
      t.spice = Math.min(5, Math.max(1, Math.round(Number(args.level) || t.spice)));
      return { ops: [{ op: "replace", path: "/spice", value: t.spice }], result: `spice is now ${t.spice}` };
    }
    case "add_course": {
      if (t.courses.length >= 12) return { ops: [], result: "error: the ticket is full (12 courses)" };
      const course: Course = { id: courseId(), title: String(args.title ?? ""), note: String(args.note ?? "") };
      t.courses.push(course);
      return { ops: [{ op: "add", path: "/courses/-", value: course }], result: `added course ${course.id}` };
    }
    case "update_course": {
      const i = t.courses.findIndex((c) => c.id === args.id);
      if (i < 0) return { ops: [], result: `error: no course with id ${args.id}` };
      t.courses[i] = { id: t.courses[i].id, title: String(args.title ?? t.courses[i].title), note: String(args.note ?? t.courses[i].note) };
      return { ops: [{ op: "replace", path: `/courses/${i}`, value: t.courses[i] }], result: "updated" };
    }
    case "remove_course": {
      const i = t.courses.findIndex((c) => c.id === args.id);
      if (i < 0) return { ops: [], result: `error: no course with id ${args.id}` };
      t.courses.splice(i, 1);
      return { ops: [{ op: "remove", path: `/courses/${i}` }], result: "86'd" };
    }
    case "add_garnish": {
      if (t.garnish.length >= 8) return { ops: [], result: "error: enough garnish already" };
      t.garnish.push(String(args.text ?? ""));
      return { ops: [{ op: "add", path: "/garnish/-", value: t.garnish.at(-1) }], result: "garnished" };
    }
    case HEADLINE_TOOL: {
      t.headlines = (Array.isArray(args.options) ? args.options : []).map(String).slice(0, 4);
      t.chosenHeadline = null;
      return {
        ops: [
          { op: "replace", path: "/headlines", value: t.headlines },
          { op: "replace", path: "/chosenHeadline", value: null },
        ],
        result: "", // filled in by the human, on resume
      };
    }
    case SUGGEST_TOOL: {
      t.suggestions = (Array.isArray(args.options) ? args.options : []).map((x) => String(x).slice(0, 80)).slice(0, 4);
      return { ops: [{ op: "replace", path: "/suggestions", value: t.suggestions }], result: "shown to the diner" };
    }
    default:
      return { ops: [], result: `error: unknown tool ${name}` };
  }
}

export function systemPrompt(t: Ticket, context: { description: string; value: string }[] = []): string {
  return `You are Chef, head of the Test Kitchen: a brisk, funny line cook who turns a raw topic into a tight article brief for a publication about building software with AI. You talk in kitchen slang ("heard", "on the fly", "86 it", "order up") but the work itself is sharp and specific.

You cook on a shared TICKET the diner watches update live. Never paste the outline into chat. The ticket is the deliverable, chat is just banter (1-3 short sentences per turn, no markdown, no emoji).

Cooking a new dish, in order:
1. set_ticket with the dish, angle and audience.
2. add_course 4-5 times: an outline that builds an argument, not a listicle.
3. add_garnish 1-2 times.
4. propose_headlines with 3-4 options, as the final call. The kitchen stops until the diner picks.
5. After they pick (or send it back), react in one line and, in that same turn, call ring_bell and suggest_next. Then stop.

Do steps 1-4 in a single turn with one sentence of banter first.

After service, the diner may ask for changes. Edit the existing ticket with update_course / remove_course / add_course rather than starting over, and only propose headlines again if asked. In the same turn as those edits, call suggest_next with fresh follow-ups that fit the ticket as it now stands (concrete edits like "Add a section on cost", never generic ones).

The diner can also edit the ticket by hand. Always trust the current ticket below over your memory. If the dining room context lists hand edits, acknowledge them in a few words and work with them, never undo them.

SPICE is a dial both of you can turn (you with set_spice, only when asked), from 1 (mild, balanced explainer) to 5 (scorching, contrarian hot take). Match the angle, section titles and headlines to it.

The dining room has tools too: set_kitchen_vibe redecorates the room when the diner asks for a different mood, ring_bell announces a finished dish. Never call either in the same turn as propose_headlines.

CURRENT TICKET (JSON):
${JSON.stringify({ ...t, suggestions: undefined })}

DINING ROOM CONTEXT (sent by the diner's browser):
${context.map((c) => `- ${c.description}: ${c.value}`).join("\n") || "- none"}`;
}
