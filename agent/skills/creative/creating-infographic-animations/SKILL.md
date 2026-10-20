---
name: creating-infographic-animations
description: Use when creating silent educational infographic animations — Kurzgesagt- or Infographic Show-style explainers, animated SVG diagrams, scene-based visual storytelling with next-button navigation and on-screen explanations, no narration or audio, built with SVG + JavaScript (GSAP) in the browser.
---

# Creating Infographic Animations

## Overview

An infographic animation is a sequence of SVG scenes where **every motion beat
communicates a causal idea** — no audio; meaning comes from shape, motion, and
on-screen text. The timeline is the script: cut beats with no idea.

## When to Use

- Silent explainers: vaccines, organs, black holes, process walkthroughs, data stories
- Interactive scene-based visuals driven by a Next button
- NOT for: narrated video, UI micro-interactions, games

## Scene Contract

One HTML file, 16:9 SVG stage (`viewBox="0 0 1920 1080"`) scaled to fit.

- `<defs>`: reusable shapes once, instanced with `<use>`
- one named `<g class="scene">` per scene: background / subject / annotation layers
- arc: hook → mechanism (one step per scene) → payoff → takeaway
- HTML HUD: Next/Back, progress dots, `Scene n / N`; last Next becomes Replay; arrow keys work
- **every scene has a title + short explanation (≤ 2 lines)**; SVG `<text>` never
  wraps — split into `<tspan>` lines at a max width, then size the plate from
  `getBBox()` after `document.fonts.ready` — never a fixed box
- screen readers: mirror each scene's title + explanation into an `aria-live` region

## Timeline Contract

One GSAP timeline per scene, built paused; **CSS is layout only, never animation**.

- `story`: finite, labeled beats — the script
- `ambient`: infinite loops (`repeat: -1`) in a separate timeline, so `story` stays seekable
- scene change: park old timelines at 0, `seek` + `play` the new one
- static placement on a wrapper `<g>`; animate an inner group with no static transform
- reduced motion: ambient paused, story at final frame

## Motion Grammar

| Beat | Use for | Default |
|---|---|---|
| Draw-in (`stroke-dashoffset`) | diagrams, arrows, checkmarks | 0.8s `power2.out` |
| Pop-in (`scale` 0.6→1) | characters, nodes, badges | 0.45s `back.out(1.7)` |
| Slide from source | causal "A produces B" | 0.7s `power3.out` |
| Fade-up | text plates | 0.5s `power2.out`, after its hero |
| Path-follow (`MotionPathPlugin`: load its script, `gsap.registerPlugin`) | travel along a route | duration ∝ distance |

Vary beats; stagger groups 80–150ms; one focal subject per beat.

## Inspection Contract (required)

Expose `window.infographic` once ready: `scenes`, `current` (numbers),
`seek(i)` → scene i's **final** frame, `seek(i, t)` → t seconds in, `play()`,
`pause()`, `duration(i)`. Screenshots use `seek` — never wall-clock timing.

## Verification (required before done)

Serve over HTTP; open with `agent-browser`; `wait --fn "window.infographic"`;
`agent-browser errors` empty (a failed CDN load leaves a blank page); `seek(i)` + screenshot every
scene, then **look at every image**: no clipped text, no overlaps, no empty scene.
Not done until you have seen every frame.

## Common Mistakes

- Every reveal the same fade-up → vary per the motion grammar
- CSS keyframes alongside the timeline → two clocks, unseekable frames
- Fixed text boxes → measure with `getBBox()`
- No inspection API → you cannot prove a frame
- 20+ competing elements in one scene → one focus per beat
- Animating a group with a static `transform` → wrapper/inner split
- Draw-in on a `<use>` → `getTotalLength()` throws and kills every timeline; draw-ins need a real `<path>`
- Re-checking after an edit on a cached page → reload with `?v=<random>`

## Example

`example-vaccine.html` — a 5-scene silent vaccine explainer implementing every
contract above. Copy it; change the art and the beats.
