# Bun HTML Game Planning Smoke

Manual smoke scenario for exercising:

- multi-step planning
- pre-execution task-graph review
- consultation before execution
- execution against a local git repo in `tmp/`
- optional multi-agent prompt guidance

The generated project stays local and gitignored under `tmp/smoke/html-game/`.

## Workspace setup

```bash
mkdir -p tmp/smoke/html-game
cd tmp/smoke/html-game
bun init -y
git init
git add .
git commit -m "baseline"
```

If you want to exercise the multi-agent prompt path, enable one of these before running Orca:

- set `codex.multiAgent: true` in the Orca config you use for the smoke run
- or ensure `~/.codex/config.toml` contains:

```toml
[features]
multi_agent = true
```

## Local spec file

Copy the spec below into `tmp/smoke/html-game/SMOKE_SPEC.md`, then run Orca from inside `tmp/smoke/html-game/`.

```md
# Build a Tiny HTML Arcade Game

Create a small single-page browser game in this Bun project using plain HTML, CSS, and JavaScript.

## Goal

Build a simple arcade-style game that is real enough to require planning and task coordination, but still small enough to finish in one run.

## Requirements

- Use vanilla HTML, CSS, and JavaScript only. No framework.
- The game must be playable in the browser from local files or a tiny local static server.
- Include a visible start state, active gameplay state, and game-over state.
- Include a restart flow so the player can immediately play again after losing.
- Include score tracking that visibly updates during play.
- Include keyboard input for movement.
- Include moving obstacles, enemies, or hazards with collision detection.
- Include lightweight styling so the game feels intentional, not raw browser defaults.
- Include a short on-screen explanation of controls and objective.
- Keep code organized enough that multiple implementation tasks could reasonably be split across files or concerns.

## Suggested game shape

Aim for a tiny dodge-or-collect game such as:

- move a player square or ship
- avoid falling hazards or collect targets
- increase score over time or on pickups
- end the run on collision

You do not need sound, assets, backend code, or external libraries.

## Verification

- Add a lightweight local verification step and run it before finishing.
- The verification can be a small Bun test, a script, or another local check that proves the required files and core game states exist.
- Keep verification simple and local.

## Acceptance criteria

- The project contains the files needed to run the game locally.
- A human can open the game and play it with the keyboard.
- Score, collision handling, game over, and restart all work.
- The local verification step passes.
- Keep the implementation simple and behavior-preserving relative to the spec.
```

## Manual run flow

From `tmp/smoke/html-game/`:

```bash
orca plan --spec ./SMOKE_SPEC.md
orca run --spec ./SMOKE_SPEC.md
```

## Manual acceptance

- `orca plan` should produce a multi-task graph, not the single fallback execution task.
- The planned graph should show clear ownership boundaries and only necessary dependencies.
- If multi-agent is enabled, the graph should favor safe parallelizable task breakdown instead of bundled do-everything tasks.
- The review/consultation steps should complete without a hard blocking failure.
- `orca run` should finish with a playable local HTML game.
- The verification step created by the run should pass.
