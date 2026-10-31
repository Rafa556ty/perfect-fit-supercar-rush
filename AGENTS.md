<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Project rules
- The racing simulation stays in the plain engine in `src/game/`; the dynamically imported Three.js renderer consumes snapshots, while React only handles HUD and menus — avoids per-frame React renders.
- Car GLBs are normalized and batched by compatible material in `models3d.ts`; optimized CDN pointers are used for racing, with the full model retained for the garage — keeps downloads and part draw calls smaller.
- Render-only phone selection and adaptive resolution live in `quality.ts` and are unit-tested; never lower the simulation cadence or traffic density to improve rendering.
- Dev-only `window.__game` exposes live `state`, `input`, and fixed-step `sim(seconds)`; canvas data attributes expose modelsReady, drawCalls, triangles and quality, and the wrapper has data-scene-ready — reuse these for software-renderer verification.
- Engine sound is pitch-matched granular playback of one real full-throttle recording (`src/game/audio.ts`), with a gearbox model driving rpm — avoids the "toy car" effect of pitch-shifting a short loop.
- Traffic passability rules live in `src/game/traffic.ts` (pure, unit-tested): cars may never line up across every lane, so the player always has a way through.
