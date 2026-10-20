# savvy-progress

A live view of everything Claude Code has working for you. Each agent gets a little animated pixel critter.

- **A band above the prompt** shows what the main conversation is doing: its model and effort, whether it's thinking, writing or running a tool, its step count, the time, how full the context is, and the session's cost. Each helper running alongside it gets a row of its own.
- **A dashboard you open with `/savvy`** has Cost, Tokens and Time tiles, then a card for each agent. Each card shows its critter, model, effort, to-do progress, context, estimated cost and time. Below the cards come workflow runs, finished helpers (folded under `f`), tasks, background shells and monitors, MCP servers, a per-second timeline, and an activity feed.

Each critter wears a hat for its type: a crown for the main conversation, a miner's helmet for Explore, a wizard's hat for Plan, a hard hat for general-purpose agents. They act out what they're doing:
- while thinking, they bob as thought bubbles rise and light up
- while writing, they look down and scribble with a pencil
- while running a tool, they swing a pickaxe, wand, hammer or book
- when finished, they cheer; when they fail, they shed a tear; when stopped, they fall asleep

The mod works in the terminal and in the Claude desktop app. In the terminal, the critters are pixel art repainted in place. In the desktop app, they're small looping animations.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install savvy-progress --marketplace andaraiwin/savvy-progress
```

Answer `y` to add the marketplace, then press Enter to install it for your user. It starts working right away, with no restart.

From a shell:

```
claude plugin install savvy-progress --marketplace andaraiwin/savvy-progress
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `andaraiwin/savvy-progress`, then **Add plugin**.

## Use

| Command | What it does |
| --- | --- |
| `/savvy` | Opens the dashboard, or closes it |
| `/savvy band` | Hides the band above the prompt, or shows it again |
| `/savvy clear` | Clears finished helpers from the dashboard |

The dashboard opens by itself when a workflow or two helpers start at once. That happens only in a fullscreen terminal or in the desktop app.

## Settings

Change these in `/config`:

- **autoOpenPane** (on by default): open the dashboard by itself when a workflow or two helpers are running.
- **liveModelPhase** (on by default): follow each model request as it streams, so phases and token counts update live.

## Notes

- The mod adds nothing to the model's prompt, so it costs no tokens to keep on. Running a `/savvy` command adds one short line to the conversation.
- The Cost tile is the session's cost, as `/cost` reports it. The cost shown on each card is an estimate at the API's list prices.
