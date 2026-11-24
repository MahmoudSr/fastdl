---
name: fastdl
description: A competition pool seen from above, where eight lanes race one file to the wall.
colors:
  water: "#27b0a8"
  grout: "rgb(255 255 255 / 0.2)"
  water-lit: "rgb(255 255 255 / 0.32)"
  floor-line: "rgb(8 40 52 / 0.62)"
  on-water: "#07202b"
  deck: "#0b2230"
  deck-2: "#123444"
  deck-line: "#21495a"
  on-deck: "#eef7f6"
  on-deck-soft: "#a8d4cf"
  wall: "#f2f7f7"
  wall-grout: "#dce8e8"
  on-wall: "#0b2230"
  on-wall-soft: "#3d5a63"
  rope: "#e2323f"
  rope-float: "#ffffff"
  cap: "#ffd23f"
  cap-hover: "#ffdc66"
  cap-ink: "#0b2230"
  split: "#ff4f8b"
  board: "#05090b"
  board-edge: "#1b2328"
  led: "#ffb000"
  led-soft: "#c98b00"
  led-spent: "#c3a25a"
  sign-face: "#ffffff"
  water-night: "#0f625e"
  grout-night: "rgb(255 255 255 / 0.08)"
  water-lit-night: "rgb(190 255 246 / 0.2)"
  floor-line-night: "rgb(0 10 14 / 0.62)"
  on-water-night: "#eafaf7"
  deck-night: "#061218"
  deck-2-night: "#0c1f28"
  deck-line-night: "#1a3440"
  wall-night: "#0c171c"
  wall-grout-night: "#15252b"
  on-wall-night: "#e4eff0"
  on-wall-soft-night: "#9db5b9"
typography:
  display:
    fontFamily: "Big Shoulders Display, Arial Narrow, sans-serif"
    fontSize: "clamp(3.2rem, 7.6vw, 6rem)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Big Shoulders Display, Arial Narrow, sans-serif"
    fontSize: "clamp(2.6rem, 5.6vw, 4.4rem)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Big Shoulders Display, Arial Narrow, sans-serif"
    fontSize: "clamp(1.7rem, 2.8vw, 2.4rem)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.005em"
  lane-number:
    fontFamily: "Big Shoulders Display, Arial Narrow, sans-serif"
    fontSize: "clamp(1.8rem, 3.4vw, 2.8rem)"
    fontWeight: 800
    lineHeight: 1
  body:
    fontFamily: "Atkinson Hyperlegible Next, Segoe UI, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  body-strong:
    fontFamily: "Atkinson Hyperlegible Next, Segoe UI, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: 1.6
  label:
    fontFamily: "Big Shoulders Display, Arial Narrow, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.14em"
  button:
    fontFamily: "Big Shoulders Display, Arial Narrow, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.02em"
  led-digits:
    fontFamily: "Doto, ui-monospace, monospace"
    fontSize: "clamp(1.7rem, 2.6vw, 2.2rem)"
    fontWeight: 800
    lineHeight: 1
    fontFeature: "tnum"
  code:
    fontFamily: "ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "0.88em"
rounded:
  hairline: "2px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  sign: "10px"
  frame: "12px"
spacing:
  tile: "24px"
  gutter: "clamp(16px, 5vw, 72px)"
  section: "clamp(64px, 10vw, 120px)"
  column-gap: "clamp(32px, 5vw, 72px)"
  container: "1240px"
components:
  button-cap:
    backgroundColor: "{colors.cap}"
    textColor: "{colors.cap-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0.7em 1.3em"
    height: "52px"
  button-cap-hover:
    backgroundColor: "{colors.cap-hover}"
    textColor: "{colors.cap-ink}"
  button-line:
    backgroundColor: "transparent"
    textColor: "currentColor"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: "0.7em 1.3em"
    height: "52px"
  nav-cta:
    backgroundColor: "{colors.cap}"
    textColor: "{colors.cap-ink}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  timing-board:
    backgroundColor: "{colors.board}"
    textColor: "{colors.led}"
    rounded: "{rounded.lg}"
    padding: "14px 18px"
  board-switch-on:
    backgroundColor: "{colors.led}"
    textColor: "{colors.board}"
    typography: "{typography.label}"
    padding: "10px 12px"
    height: "40px"
  lane-block:
    backgroundColor: "{colors.deck-2}"
    textColor: "{colors.on-deck}"
    typography: "{typography.lane-number}"
  pool-sign:
    backgroundColor: "{colors.sign-face}"
    textColor: "{colors.on-wall}"
    rounded: "{rounded.sign}"
  pool-sign-head:
    backgroundColor: "{colors.rope}"
    textColor: "{colors.sign-face}"
    padding: "14px 20px 12px"
---

# Design System: fastdl

## Overview

**Creative North Star: "Eight Lanes"**

The site is a competition pool seen from directly above. fastdl's eight connections are eight swim lanes racing one file to the wall, so the page is built from the pool's own materials: aqua tile water on a fixed grout grid for the big regions, a navy deck for headers and steps, plain pale wall surfaces behind long prose, red-and-white lane ropes where water begins, yellow touchpads and caps for everything you can press, and a black LED timing board for the numbers that matter. Nothing is decorated that a real pool would not have.

The density is that of a meet program: bold condensed headlines, short honest paragraphs, numbered lanes for features, a pool-rules sign for policy. The page alternates surfaces (deck, water, wall) section by section, the way you walk from the deck to the water's edge to the wall. At night (dark scheme) the pool keeps its shape and turns to underwater lights: dark teal water, near-black deck, dark tile walls. The timing board, the ropes, the caps and the sign do not change, because they are objects in the pool, not paint on it.

Motion is one race. A single pace clock drives the hero heat; everything else stays still. With reduced motion the visitor sees a frozen frame part-way through the heat, never an empty pool.

**Key Characteristics:**
- Three surfaces only: water (tiled), deck (navy), wall (plain pale).
- A fixed 24px tile module that never rescales.
- Pool objects as UI: ropes as dividers, touchpads and caps as calls to action, a timing board for metrics, a sign for rules.
- One reserved accent (pink) that means "this lane is being split" and nothing else.
- Condensed sports display type over a highly legible text face; dot-matrix digits only on the board.

## Colors

Pool-literal color: aqua water, navy deck, red rope, yellow cap, amber LED on black, with one pink kept in reserve.

### Primary
- **Pool Aqua** (water): the tiled water surface for the hero pool, the feature lanes and the final download section. Always carries the grout grid; text on it is Pool Bottom Ink.
- **Pool Deck Navy** (deck): header, footer, hero deck band, app section, setup steps. Also the ink on wall surfaces (on-wall shares the value).

### Secondary
- **Touchpad Yellow** (cap): primary buttons, the nav download link, the touchpads at the end of each lane, lane-block edges, step numerals, the hero headline's second half, selection and focus. Its hover is a lighter **Cap Highlight** (cap-hover). Text on yellow is always Cap Ink (cap-ink, navy).
- **Lane Rope Red** (rope) with **Float White** (rope-float): lane ropes and the pool-rules sign header and list markers.

### Tertiary
- **Timing Board Black** (board) with **Board Bezel** (board-edge): the timing board, the results table, the pairing-code chips.
- **LED Amber** (led): every digit on the board, plus the active state of the board's mode switch. **LED Dim Amber** (led-soft) for board labels and units; **Spent Amber** (led-spent) for the slower comparison row.
- **Split Pink** (split): only the lane being split in the live heat (its touchpad and swimmer flash pink for 1.4 s).

### Neutral
- **Pool Bottom Ink** (on-water): text on water. At night it inverts to on-water-night.
- **Deck Raised** (deck-2) and **Deck Seam** (deck-line): lane blocks, coping, the band above a water section, dividers and borders on deck.
- **Deck Foam** (on-deck) and **Deck Mist** (on-deck-soft): primary and secondary text on deck.
- **Wall Tile** (wall) and **Wall Grout** (wall-grout): plain wall surfaces and the hairlines on them.
- **Wall Ink Soft** (on-wall-soft): secondary prose on walls.
- **Sign Face** (sign-face): the white of the pool-rules sign, in both schemes.
- **Grout**, **Water Light** (water-lit) and **Floor Line** (floor-line): translucent overlays on water: the tile grid, a lane's wake, the dark lane line on the pool floor.

### Named Rules
**The Reserved Pink Rule.** Split Pink appears only where a lane is being split. No links, badges, highlights or illustrations in pink, ever. If nothing is splitting, there is no pink on screen.

**The Numbers On The Board Rule.** Race metrics (speed, time, size done, measured results, pairing codes) are set in LED Amber on Timing Board Black. Numbers inside prose and the small per-lane speed tags stay in the body face.

**The Night Pool Rule.** The dark scheme swaps water, deck and wall for their -night values and keeps every pool object (board, ropes, caps, sign, split pink) unchanged.

## Typography

**Display Font:** Big Shoulders Display (with Arial Narrow, sans-serif), weights 800 and 600
**Body Font:** Atkinson Hyperlegible Next (with Segoe UI, system-ui), weights 400 and 700
**Digits Font:** Doto 800 (with ui-monospace), board only
**Code Font:** ui-monospace, Cascadia Mono, Consolas

**Character:** a condensed stadium face for lane numbers, headings, buttons and board labels, set tight and heavy like meet signage, over a text face built for legibility. Doto gives the board its dot-matrix LED look.

### Hierarchy
- **Display** (800, clamp 3.2rem to 6rem, 0.95): the hero line and the final "Download fastdl" heading.
- **Headline** (800, clamp 2.6rem to 4.4rem, 0.95): section headings, balanced wrap.
- **Title** (800, clamp 1.7rem to 2.4rem): feature and step headings.
- **Lane Number** (800, clamp 1.8rem to 2.8rem): numerals in lane blocks, step counters (3.4rem), guide contents numerals.
- **Body** (400, 1.0625rem, 1.6): prose; ledes run 1.1 to 1.15rem. Measure 40 to 62ch in landing sections, 72ch in the guide.
- **Label** (600, 0.85 to 0.95rem, 0.12 to 0.14em tracking, uppercase): board titles, units, table headers, the guide's contents title.
- **Button** (800, 1.35rem, 0.02em, uppercase): every button; the nav download link at 1.05rem, 0.04em.
- **LED Digits** (800, clamp 1.7rem to 2.2rem on the hero board, up to 1.9rem in the results table, 2rem in code chips): tabular figures with a soft amber glow.

### Named Rules
**The Separator Swap Rule.** Doto draws "." like a plus sign, so every "." and ":" inside LED digits is set in Big Shoulders Display 800. Any new board number must pass through the same separator swap.

**The Uppercase Belongs To The Display Face Rule.** Uppercase and wide tracking are used only in Big Shoulders (buttons, labels, sign header). Body text is never set in capitals.

## Layout

Content sits in a centered container of at most 1240px with a fluid side gutter (16px to 72px). Water regions break out edge to edge; the hero pool spans the full viewport width with lane blocks fixed to the left wall.

Sections stack as alternating full-bleed surfaces with generous vertical padding (64px to 120px). Two-column sections use a 5:7 split (copy left, object right: board, sign, safety list) with a 32px to 72px column gap, collapsing to one column under 900px. Setup steps run as three columns on a subgrid with seams between them, stacking under 900px.

The feature lanes are a full-width list: a lane block (48px to 84px), a 4fr title, a 6fr description, each row at least 112px tall, separated by lane ropes. Under 900px the description drops below the title beside the block.

The hero is sized so all eight lanes fit the first screen: lane height is derived from the viewport height (22px to 60px), with a tighter deck on laptops under 800px tall. On phones (under 860px) the order is headline, offer and download button, the pool (24px lanes), then the board.

### Named Rules
**The Fixed Tile Rule.** The water grout grid is a 24px tile at every viewport and scheme. Never scale it, animate it or change its pitch; content moves over the tile, the tile does not move.

**The Water Begins With A Rope Rule.** A water section that follows another surface opens with a 22px deck-colored edge and a red-and-white lane rope; the hero pool sits between two coping strips (22px grate).

## Elevation & Depth

Mostly flat, by surface change rather than lift: deck, water and wall sit side by side with hard edges. Depth is reserved for physical objects floating on or mounted near the water, and each object's shadow is soft and tinted toward the pool's dark teal.

### Shadow Vocabulary
- **Rope float** (`box-shadow: 0 2px 3px rgb(0 30 40 / 0.25)`): lane ropes sitting on the water.
- **Touchpad** (`box-shadow: 0 2px 4px rgb(0 30 40 / 0.3)`; finish pad `0 4px 10px rgb(0 30 40 / 0.3)`): yellow pads at the lane ends.
- **Swimmer cap** (`box-shadow: 0 0 0 2px var(--deck), 0 3px 6px rgb(0 30 40 / 0.35)`): the cap ring plus a small cast shadow.
- **Mounted board** (`box-shadow: 0 18px 40px -18px rgb(0 0 0 / 0.7)`; results board `0 24px 48px -24px rgb(0 20 30 / 0.55)`): the timing board hanging off the deck.
- **Sign** (`box-shadow: 0 2px 0 #c7d6d6, 0 22px 40px -24px rgb(0 30 40 / 0.45)`): the rules sign's edge and its drop.
- **LED glow** (`text-shadow: 0 0 10px rgb(255 176 0 / 0.45)`): lit digits only.

### Named Rules
**The Objects Float, Surfaces Don't Rule.** Shadows belong to pool objects (ropes, pads, caps, board, sign, cap button). Sections, text blocks and the app screenshot frame never get a shadow.

## Shapes

Small, practical radii: 2px on pads and floor lines, 4px on code and lane speed tags, 6px on buttons and board controls, 8px on the boards, 10px on the sign, 12px on the top corners of the app screenshot frame. Ropes are pill-ended (5px), swimmers are circles, wakes taper with a round leading edge.

Borders do structural work: a 4 to 5px yellow edge on lane blocks (the wall's touchpad line), 2px seams between steps, 2px ink rules above wall lists and guide headings, 1px grout hairlines between list items. Lane lines on the pool floor end in a T at each wall.

## Components

### Buttons
Tactile and loud, like a yellow cap on dark water.
- **Shape:** gently rounded (6px), at least 52px tall (48px in steps), 2px border, icon and label with a 0.6em gap.
- **Cap (primary):** Touchpad Yellow with Cap Ink, Big Shoulders 800 uppercase. Carries a 2px dark lip and a soft yellow under-glow (`0 2px 0 rgb(0 0 0 / 0.25), 0 10px 24px -10px rgb(255 210 63 / 0.6)`).
- **Hover / Active:** lifts 1px and lightens to Cap Highlight; presses 1px down with the lip shrinking to 1px. Transitions 160ms on the ease-out curve.
- **Line (secondary):** transparent with a currentColor border; hover fills with 10% of currentColor. Used beside a cap button, never alone as the main call.
- **Arrow link:** bold body text with a line arrow that slides 3px right on hover.
- **Focus:** a 3px Touchpad Yellow outline, offset 3px; on wall surfaces the outline turns navy.

### Timing Board (signature)
The black board that carries every race number. Board Black with a 2px bezel and 8px corners, label row in LED Dim Amber uppercase, digits in Doto amber with glow and tabular figures, separators swapped to the display face. Controls sit in the board: a two-part mode switch (active part filled amber with black text) and a Pause/Play button, both 40px tall, outlined in the bezel color. The same board styling holds the results table and the pairing-code chips.

### The Pool and Lanes (signature)
Eight lanes on tiled water, each with a navy lane block numbered in Big Shoulders and a yellow edge, a dark floor line with T ends, a translucent wake that grows with distance swum, a yellow swimmer cap with foam, and a yellow touchpad at the lane's current wall. Lanes are separated by ropes, alternating red-only and red-and-white floats. When a lane finishes early and takes half the biggest piece left, both lanes' pads and caps flash Split Pink and the walls move (700ms ease-out). The feature list reuses the lane: numbered block, title, text, rope between rows.

### Pool Rules Sign (signature)
Policy is posted as a sign: white face, 3px navy border, 10px corners, a Lane Rope Red header in Big Shoulders uppercase with wide tracking, and a numbered list whose markers are red display numerals. The sign stays white at night.

### Navigation
Deck band, at least 72px tall: the app icon (34px, 8px corners) beside "fastdl" in Big Shoulders 800, then bold Deck Mist links that turn Deck Foam and underline on hover or when current, and a yellow cap Download link at the end. The GitHub link hides under 560px.

### Guide Contents
A sticky contents list beside the guide's prose: label-style title, numbered entries on a 2px grout rail; the section being read gets a navy rail and a soft yellow wash (at night, a water-tinted wash), with no weight change so the list never reflows.

### Inline Code and Notes
Code uses the system mono at 0.88em on a 9% currentColor tint with 4px corners; code blocks sit on Deck Navy. Callouts in the guide are 2px ink-bordered boxes with a light yellow wash.

## Do's and Don'ts

### Do:
- **Do** build every new region from one of the three surfaces (water, deck, wall) and pair it with its own ink (on-water, on-deck, on-wall).
- **Do** keep the water's grout grid at a fixed 24px tile.
- **Do** open a water section with the deck edge and a lane rope, and separate stacked lane rows with ropes, alternating plain and red-and-white.
- **Do** put race metrics on the Timing Board in Doto with the separator swap.
- **Do** use Touchpad Yellow for the action the page wants, with navy text on it.
- **Do** drive any live demonstration from one shared clock, offer a pause control, and show a still mid-race frame under reduced motion.
- **Do** define both light and night values for any new surface token.

### Don't:
- **Don't** use Split Pink for anything except a lane being split.
- **Don't** set Doto outside the board, or let a "." or ":" render in Doto.
- **Don't** tile wall surfaces; walls stay plain so prose reads cleanly.
- **Don't** put shadows on sections or text blocks; only pool objects cast them.
- **Don't** run independent loops or decorative animation outside the race clock.
- **Don't** set body text in uppercase or tracked capitals.
