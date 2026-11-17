# Command deck: the desktop UI redesign

Status: built (2026-11-17), as written. As built: `AgentOrbit` (placement math, pods) and the compact `StageStrip` stay in `src/ui/hud/`; the deck's pods add the float and the amber needs-you ring there; Space Grotesk is gone (Inter everywhere).
Source: the owner's "Spatial Multi-Agent Command Deck" mockup, with these decisions:

- **Theme follows the open project.** No domain toggle. Every project is dark. Software projects: cyan-blue
  orb and accent. Red-team projects: red. Blue-team and purple-team templates keep blue and violet.
- **Approvals stay in the Inbox.** An agent card that needs you glows amber and opens that exact item there.
- **The orb is today's canvas particle core** (`ParticleCore`), recoloured by the theme.
- **Inter everywhere; Material Symbols icons bundled** (no font from another site: the page's CSP forbids it).
  Exception: terminals keep a monospace font, or CLI output stops lining up.
- Desktop (1000 px and up) only. The compact layout gets the new theme colours, not a new layout.

## What the screen is

```
┌ header ───────────────────────────────────────────────────────────────────────┐
│ [AO] ArimaOps / Askwell ▾ ●   Software · Build ▸     ⌘K …     3 working · $2.10  [2 need you]  ⚙ │
├──┬────────────────────────────────────────────────────────────────────────────┤
│▣ │  Build orbit / 3 working · 1 needs you                  (dot-grid canvas)   │
│▤ │                        ┌ pod ┐                                             │
│✉•│            ┌ pod ┐   ( particle orb )   ┌ pod ┐                            │
│☺ │                       Askwell · in sync                                     │
│… │                        └ pod ┘                                             │
├──┴────────────────────────────────────────────────────────────────────────────┤
│ Software delivery    Spec 0 › Plan 5 › [Build 2] › Review 0 › Merge 0     ● connected │
└───────────────────────────────────────────────────────────────────────────────┘
                                                  ┌ slide-over (agent, terminal…) ┐
```

Board, Inbox, Chat, Agents, Flow, PRs or Findings, and Usage replace the orbit area as pages (as today).
An agent, a terminal, an environment or projects open in the slide-over on the right.

## Two shapes considered

**A. Restyle in place.** Keep `SpatialHud`, `AgentOrbit`, `StageStrip`, `TelemetryCorners` and edit each.
Small diffs, but the mockup's frame is different (a full-width header, a docked rail, a footer ribbon instead of
floating corners), so each file would be rewritten anyway, and the colour switch would end up as `redTeam`
booleans in every component, like today.

**B (chosen). A new deck shell, one theme switch.** New `src/ui/deck/` with the frame and the home, reusing
every page, drawer, the command bar and the orb. Colour comes from one attribute on the root
(`data-theme="build|redteam|blueteam|purpleteam"`) that sets CSS variables; components only use `accent`,
`accent-2`, etc., and never ask which project type it is. Replaced files are deleted.

B wins on depth: one `theme` value in, every colour out, no per-component branching. The mockup's own script
shows the cost of the other way: about 40 elements restyled by hand on each switch.

## Usage first

```tsx
// src/App.tsx, desktop branch: the only call site.
<Deck />

// src/ui/deck/Deck.tsx
export function Deck() {
  const snap = useOffice((s) => s.snap);
  const theme = useProjectTheme(snap);               // "build" | "redteam" | …; sets <html data-theme>
  return (
    <DeckFrame header={<DeckHeader snap={snap} />} rail={<DeckRail />} footer={home && <StageRibbon snap={snap} />}>
      {page ?? <Orbit snap={snap} theme={theme} />}   // page: Board, Inbox, Chat… (today's components)
      <SlideOver />                                   // today's side panel: agent, terminal, env, projects
    </DeckFrame>
  );
}
```

## Module map

| File | Job | From |
|---|---|---|
| `ui/deck/Deck.tsx` | picks the page or the orbit; routes rail clicks; holds the slide-over | `SpatialHud` (routing kept) |
| `ui/deck/DeckHeader.tsx` | brand, project switcher pill with type, ⌘K, working/burn, need-you pill, setup, settings, user menu | `TelemetryCorners`, header part of `SpatialHud` |
| `ui/deck/DeckRail.tsx` | icon rail with tooltips and badges; PRs for build, Findings for security; user avatar at the bottom | rail part of `SpatialHud` |
| `ui/deck/Orbit.tsx` | the orb, the pods placed around it, the caption under the orb | `AgentOrbit` (placement math kept) |
| `ui/deck/AgentPod.tsx` | one agent card: avatar, name, role · CLI, status chip, task, tokens · cost; needs-you state | card part of `AgentOrbit` |
| `ui/deck/StageRibbon.tsx` | footer: pipeline name, stages with counts (active one raised), connection state | `StageStrip`, `ConnectionBanner` (inline state) |
| `ui/deck/SlideOver.tsx` | right panel under the header, slide + fade, Esc closes, focus kept inside | side panel part of `SpatialHud` |
| `ui/deck/Icon.tsx` | `<Icon name="inbox" />` over the bundled Material Symbols font | `NavIcon` SVGs (desktop) |
| `ui/theme/projectTheme.ts` | `projectTheme(snap)` and `THEMES` (orb RGB, labels, pipeline name) | `hud/theme.ts` (`projectMode`) |
| `ui/hud/ParticleCore.tsx` | unchanged drawing; takes `palette` instead of `redTeam` | kept |

Deleted when the deck lands: `SpatialHud.tsx`, `TelemetryCorners.tsx`, `AgentOrbit.tsx`, `StageStrip.tsx`
(the compact layout's orbit and strip move to the deck's `Orbit` and `StageRibbon` with a `compact` prop).

## Types

```ts
// src/ui/theme/projectTheme.ts
export type ThemeId = "build" | "redteam" | "blueteam" | "purpleteam";

export interface Theme {
  id: ThemeId;
  label: string;                         // "Software", "Red team", …
  pipeline: string;                      // footer: "Software delivery", "Red-team engagement", …
  orb: { primary: Rgb; secondary: Rgb }; // canvas needs numbers, not CSS
  security: boolean;                     // rail shows Findings instead of PRs
}
export type Rgb = readonly [number, number, number];

export const THEMES: Record<ThemeId, Theme> = { /* build: cyan + sky; redteam: red + amber; blueteam; purpleteam */ };
export function projectTheme(snap: OfficeSnapshot | null): Theme { throw new Error("not implemented"); } // today's projectMode rules
export function useProjectTheme(snap: OfficeSnapshot | null): Theme { throw new Error("not implemented"); } // + sets <html data-theme>

// src/ui/hud/ParticleCore.tsx
interface ParticleCoreProps { workingCount: number; attentionCount: number; palette: Theme["orb"]; compact?: boolean }

// src/ui/deck/AgentPod.tsx
type PodState = "working" | "needs-you" | "idle" | "error" | "off";
interface AgentPodProps {
  member: Member;                        // today's selectTeam row: config + status + usage
  task: Task | null;
  state: PodState;
  onOpen(): void;                        // the agent slide-over
  onNeedsYou?(): void;                   // needs-you only: opens its Inbox item
  floatDelay: number;                    // staggered idle float; 0 motion with reduced-motion
}
```

```css
/* src/index.css: the only place colours change by project */
:root, [data-theme="build"]      { --accent: #00f0ff; --accent-2: #38bdf8; --accent-glow: rgb(0 240 255 / .16); }
[data-theme="redteam"]           { --accent: #ef4444; --accent-2: #f59e0b; --accent-glow: rgb(239 68 68 / .2); }
[data-theme="blueteam"]          { --accent: #38bdf8; --accent-2: #00f0ff; … }
[data-theme="purpleteam"]        { --accent: #a371f7; --accent-2: #ef4444; … }
@theme { --color-accent: var(--accent); --color-accent-2: var(--accent-2); }
```

## Motion (all of it off with reduced motion, nothing ever hides information)

- Orb: as today (spins faster with more agents working, pulses while something needs you).
- Pods: a slow staggered float (4 to 6 s, 5 px); a working pod's status dot pulses; a needs-you pod has an amber
  ring that breathes; hover lifts and sharpens the border.
- Theme change (switching to a project of another type): the accent and orb colours cross-fade over 600 ms.
- Pages and the slide-over: slide and fade in 250 ms on the mockup's curve; stage counts tick when they change.

## UX fixes folded in

- Every rail icon has a visible tooltip and an `aria-label`; badges also have text for screen readers.
- The need-you pill and an amber pod open the item itself, not just the Inbox.
- The stage ribbon's stages are buttons that open the Board filtered to that stage.
- Text floor stays 12 px (11 px only for tiny counters), contrast checked on both red and cyan themes.
- One focus ring style, keyboard order header → rail → pods → ribbon, Esc closes the slide-over.

## Decided (2026-11-17)

1. **Header centre:** the ⌘K command bar; the project type chip sits beside the project name.
2. **Setup, Start all, Sign out:** Setup is a pill only while something is left to do; Start all and Sign out
   move into the user menu at the bottom of the rail.
3. **AGENTS.md design rules** are updated with the build: Inter everywhere (monospace only in terminals), one
   accent per project type.
4. The owner asked for changes to the sketch before any code (pending).

## Risks

- Material Symbols' outlined font is a few hundred KB; it loads with the app (same origin, cached).
- Pod placement must hold from 1 to about 10 agents on 1000 px wide screens; today's placement math does,
  and is kept.
- The compact layout shares `Orbit` and `StageRibbon`, so phones need a check too even though their layout
  doesn't change.
