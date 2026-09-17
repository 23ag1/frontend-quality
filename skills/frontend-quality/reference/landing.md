# Landings and promo sites

Read it together with [the skill body](../SKILL.md). For applications and admin
panels see [product.md](product.md).

This is not about "adding animation". Awards go to sites that resolve the conflict
between an artistic idea and flawless execution. The ones that fail are the ones
where the idea won.

## What separates a winner from a rejection

Rejected sites: built on a template, load longer than five seconds, a mobile
version bolted on afterwards by scaling that falls apart on a real device.

Winners: a hierarchy built for the task, **one signature moment polished to a
shine**, even performance on mid-range hardware, real high-quality media in every
section rather than placeholders on the inner pages.

## Arithmetic, not taste

Awwwards weighting: **design 40%, usability 30%, creativity 20%, content 10%.** At
least 18 jurors score, the three extreme scores are dropped. Honourable Mention
from 6.5, Site of the Day usually from 8.0; the day's winners go to the developer
jury, where 7.0 earns a Developer Award. A separate mobile jury awards Mobile
Excellence from 75 out of 100.

**Usability weighs one and a half times more than creativity.** Every effect that
gets in the way of using the site takes away more than it adds. That is the main
argument against showing off, and it is arithmetic rather than taste.

## Order of work

Breaking the order is the main cause of failure. Every step ends with something
you can show.

1. **References, not imagination.** Three to five concrete sites taken apart: which
   effects, built how, weighing what. Without that you get the statistical average.
2. **Design context.** `.impeccable.md` is mandatory: audience, scenarios, tone.
   Without it "expressive" means "like everyone else".
3. **Choosing one move.** Formulate two or three directions, show them to the
   owner, get a choice. **One** signature moment goes into the work; everything
   else stays restrained. A custom cursor, magnetic buttons, parallax, shattering
   text and a shader background at once are not five moves, they are zero.
4. **Budgets before the code.** Write the numbers down (the table below) and decide
   in advance what is switched off on mobile and how the page looks without WebGL.
5. **The skeleton without effects.** First the site fully works: content,
   navigation, forms, the mobile version, accessibility. Effects are a separate
   layer on top that can be removed. If the move does not work out, what remains is
   a working site rather than rubble.
6. **The graphics layer.** A two-layer architecture: the DOM carries semantics,
   layout and accessibility; a full-screen canvas with the GPU scene sits over it;
   an orchestrator sits between them. No synchronous DOM manipulation from the
   render loop.
7. **Measurement after every layer** (`verify-motion.mjs`, `verify-ui.mjs`).
   Beautiful in a still and stuttering in motion is the most common failure, and a
   screenshot never shows it.

## Budgets you do not go below

| Metric | Mobile | Desktop |
|---|---|---|
| Initial bundle (gzip) | ≤ 200 KB | ≤ 350 KB |
| FCP | ≤ 1.0 s | ≤ 800 ms |
| LCP | ≤ 2.5 s | ≤ 1.8 s |
| INP | ≤ 200 ms | ≤ 100 ms |
| VRAM | ≤ 128 MB | ≤ 384 MB |
| Draw calls per frame | ≤ 50 | ≤ 100 |
| Frame time | ≤ 16.67 ms | ≤ 8.33 ms |

Exceeding VRAM on iOS kills the tab — that is not "it gets slower", that is a
crash.

## Five ways to ruin it

1. **Piling up moves.** Cured by step 3: one moment, everything else quiet.
2. **Forgetting mid-range hardware.** Development happens on a fast machine;
   measuring with the CPU throttled fourfold is mandatory.
3. **Leaking memory.** Three.js does not collect GPU resources by itself: removing a
   mesh from the scene frees only the JavaScript wrapper, while buffers, shaders and
   textures stay in VRAM.
4. **Killing accessibility.** A canvas is semantically empty and invisible to screen
   readers. It needs a parallel DOM layer kept in sync with the scene.
5. **Ignoring `prefers-reduced-motion`.** Checked automatically: `verify-motion.mjs`
   opens the page with the setting on and fails the check if infinite animations
   keep running.

## What else gets checked on a landing but not in a product

- Opening every inner page by direct link, not only from the home page.
- Meta tags and the share image: the page ends up in messengers and social feeds.
- Forms: success, network error, double submission, autofill, the mobile keyboard
  (`inputmode`, `autocomplete`).
- Video and heavy media: a poster, `preload`, no autoplay under data saving.
- A real device, not only emulation: `dvh`, scroll inertia and scene weight behave
  differently on a phone.

Budgets and measurement methodology live in the `frontend-performance` skill;
hand-off lives in [checklist.md](checklist.md).
