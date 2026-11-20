# The Test Kitchen

An [AG-UI](https://docs.ag-ui.com/introduction) demo. You name a topic, a line-cook agent turns it into an article brief on a live order ticket, and a wire tap shows every protocol event that made it happen.

![Order up: the agent rings the bell in the browser after the human picks a headline](docs/order-up.png)

There is no agent framework here. The server is about 200 lines of TypeScript that reads a `RunAgentInput` and writes AG-UI events over SSE. The browser uses the official `@ag-ui/client`. That makes it a good place to see what the protocol itself does.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. One process serves both the UI and the agent endpoint (`POST /agent`).

With no API key the kitchen runs a scripted chef that speaks exactly the same protocol. For a real model, copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. `KITCHEN_MODEL` takes any OpenRouter model that supports tool calling.

## Things to try

1. Set the spice dial, then click a suggested order. Watch the ticket fill in course by course while the model is still streaming.
2. The kitchen stops and waits for you to pick a headline. Pick one, or send them all back.
3. Edit the ticket by hand: retitle a course, delete one, change the spice. Then ask for changes and the chef works from your edits.
4. Ask for "fine dining" or "food truck vibes".
5. Click any row in the wire tap for the raw JSON.

## What each part demonstrates

| You see | AG-UI feature | Where |
| --- | --- | --- |
| Chef's banter streaming in | `TEXT_MESSAGE_START / CONTENT / END` | `server/agent.ts` |
| The "muttering" lines | `REASONING_*` events from the model's thinking | `server/agent.ts` |
| Tool chips under a message | `TOOL_CALL_START / ARGS / END / RESULT` | `server/agent.ts` |
| Ticket updating live | Shared state: `STATE_SNAPSHOT`, then `STATE_DELTA` JSON Patches | `server/kitchen.ts` |
| Your hand edits reaching the chef | State flows both ways: `agent.setState()` rides in the next `RunAgentInput.state` | `src/main.ts` |
| The headline pause | Interrupts: `RUN_FINISHED` with `outcome: interrupt`, resumed with `RunAgentInput.resume` | both |
| Confetti, bell, redecorating | Frontend tools: declared by the browser, called by the agent, executed in the tab | `src/main.ts` |
| The status pill | `STEP_STARTED / STEP_FINISHED` | both |
| The model badge | `CUSTOM` event | both |

![The run is paused on an interrupt until the human picks a headline](docs/interrupt.png)

## How it fits together

```
src/main.ts      HttpAgent, frontend tools, rendering from agent.messages + agent.state
src/wiretap.ts   the event log
server/agent.ts  the AG-UI endpoint: RunAgentInput in, event stream out
server/kitchen.ts  the ticket, the server tools, and the JSON Patch each one emits
server/llm.ts    OpenRouter streaming, plus the scripted chef
vite.config.ts   mounts the endpoint on Vite's dev server
```

Three design points worth noticing:

- **The server holds no session.** Messages, the ticket, and even a paused run arrive in each request. An interrupt's id encodes the tool call it is waiting on, so the resume request carries everything needed to continue.
- **Server tools run as each call finishes streaming**, not at the end of the model's turn. That is why the ticket fills in one course at a time.
- **A frontend tool call ends the run without a result.** The browser executes it, appends a `tool` message, and starts a follow-up run so the agent can react. See `run()` in `src/main.ts`.

## Notes

- Built against AG-UI 1.0 (`@ag-ui/client`, `@ag-ui/core`, `@ag-ui/encoder` 1.0.5).
- This is a demo: there is no auth or rate limiting on `/agent`, so don't expose it publicly with a key configured.
