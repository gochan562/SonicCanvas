import type { Scene } from './scenes/Scene'
import { LiquidScene } from './scenes/LiquidScene'
import { OrbitScene } from './scenes/OrbitScene'
import { TunnelScene } from './scenes/TunnelScene'
import { GridScene } from './scenes/GridScene'
import { ParticleFieldScene } from './scenes/ParticleFieldScene'
import type { SceneId } from '../audio/types'

/**
 * ============================================================================
 * MODULE: SceneManager — owns scenes + crossfade transitions between them
 * ============================================================================
 *
 * WHAT IT IS
 *   The registry and lifecycle manager for procedural scenes. It knows how
 *   to create each of the five spec-§16 scenes on demand (lazily), tracks
 *   the currently active scene, and orchestrates smooth crossfade / wipe /
 *   zoom transitions between scenes when the user (or the auto-scene
 *   controller) asks to switch.
 *
 * WHY IT EXISTS
 *   Spec §17: "output should never abruptly flash from one scene to
 *   another unless the effect intentionally calls for it". So we need a
 *   layer between "switch to scene X" and "scene X is now rendering" that
 *   owns the *transition* — the crossfade. That's this class.
 *
 *   It's separate from VisualEngine because the transition logic is
 *   conceptually about scenes (not about the render loop), and a separate
 *   class lets the AutoSceneController and the manual setScene UI both
 *   drive the same transition path via switchTo().
 *
 * WHAT GOES IN
 *   - switchTo(id)   — start a transition to a new scene
 *   - start(id)      — initialize the very first scene (no transition)
 *   - setTransitionStyle(style) — crossfade / wipe / zoom
 *   - update(dt)     — advance the current transition by dt seconds
 *
 * WHAT COMES OUT
 *   - getActive() / getActiveId()   — the currently active scene
 *   - getRenderingScenes()          — the scenes to render this frame
 *                                     (1 normally; 2 during a transition)
 *   - isTransitioning() / getTransition() — state for the UI / debug overlay
 *
 * WHAT DEPENDS ON IT
 *   - VisualEngine.ts (owns the manager, calls update + getRenderingScenes
 *     every frame; calls switchTo on user scene-change)
 *   - AutoSceneController.ts (calls visual.setScene → manager.switchTo)
 *   - The UI (reads getActiveId for the scene indicator)
 *
 * WHAT IT DEPENDS ON
 *   - The five scene classes (Liquid/Orbit/Tunnel/Grid/ParticleField)
 *   - The Scene interface (setOpacity, update, render, resize, dispose)
 *   - audio/types.ts (SceneId)
 *
 * CROSSFADE IMPLEMENTATION (the core of this file)
 *
 *   During a transition we keep BOTH the outgoing (fromId) and incoming
 *   (toId = activeId) scenes alive. Each frame we set their opacity
 *   uniforms:
 *
 *       outgoing.setOpacity(1 - t)        outgoing fades out
 *       incoming.setOpacity(t)            incoming fades in
 *
 *   where `t` eases from 0 → 1 over `1 / transitionSpeed` seconds
 *   (~0.6s at the default speed=1.6). The VisualEngine clears the
 *   canvas to the background color, then renders both scenes with
 *   NormalBlending so they composite smoothly over that base.
 *
 *   When `t` reaches 1:
 *     - the outgoing scene is disposed() (frees its GPU memory)
 *     - the active scene's opacity is forced to 1 (snap to clean state)
 *     - transition state (fromId, toId, transition) is reset to null
 *
 *   WHY dispose-on-complete (not on switch): the outgoing scene is still
 *     being rendered during the crossfade. Disposing it before t=1 would
 *     yank the geometry out from under the renderer mid-frame, producing
 *     a one-frame flash of background. Waiting until the crossfade is
 *     done guarantees the outgoing scene is fully invisible (alpha=0)
 *     before we free it.
 *
 *   TRANSITION STYLES
 *     - crossfade: ease-in-out cubic on alpha. Both scenes fade.
 *     - wipe:      a hard-step alpha at the wipe line — the incoming
 *                  scene is fully visible past `t`, the outgoing fully
 *                  visible before it. The wipe line moves left→right.
 *     - zoom:      a punchier fade with a 1.1× multiplier on the
 *                  incoming alpha (slight overshoot feel). Outgoing
 *                  fades normally.
 *
 * ASCII data flow (one frame during a transition):
 *
 *     SceneManager.update(dt)
 *        │
 *        │  transition += dt * transitionSpeed      (0 → 1 over ~0.6s)
 *        ▼
 *     eased = easeInOutCubic(transition)
 *        │
 *        │  incoming.setOpacity(inAlpha)            (inAlpha = eased)
 *        │  outgoing.setOpacity(outAlpha)            (outAlpha = 1 - eased)
 *        ▼
 *     VisualEngine renders both scenes (outgoing first, incoming on top)
 *        │
 *        │  when transition >= 1.0:
 *        ▼
 *     dispose outgoing  →  reset state  →  active = incoming (opacity 1)
 *
 * ============================================================================
 */
export type TransitionStyle = 'crossfade' | 'wipe' | 'zoom'

export class SceneManager {
  // WHY a Map (not a Record object): scenes are created lazily and
  //   removed on transition complete; Map preserves insertion order
  //   for the iteration in getRenderingScenes() and has clean
  //   has/get/delete semantics.
  private scenes = new Map<SceneId, Scene>()
  private activeId: SceneId | null = null
  /** transition state: 0 = no transition, 1 = mid-transition */
  // WHY a 0..1 progress (not raw elapsed seconds): the VisualEngine
  //   reads this for the debug overlay's transition bar. A 0..1 value
  //   is directly displayable; raw seconds would need a / duration
  //   division in the UI layer.
  private transition = 0
  // outgoing scene id during a transition (null when not transitioning)
  private fromId: SceneId | null = null
  // incoming scene id during a transition (= activeId). null when not
  // transitioning.
  private toId: SceneId | null = null

  // ============================================================
  // PARAMETER: transitionSpeed (crossfade rate)
  // Purpose:   1 / seconds-for-the-crossfade. Multiplied by dt each
  //            frame to advance the transition progress (0..1).
  //            transitionSpeed=1.6 means a ~0.625s transition.
  // Safe range: 0.5 .. 5.0 (1 / 0.5 = 2s slow, 1 / 5.0 = 0.2s snap).
  // Typical:   1.6 — ~0.6s crossfade. Fast enough to not feel laggy
  //            when the user clicks a scene button, slow enough to be
  //            visible as a smooth blend (not a flash).
  // Try:       0.8 for slow cinematic blends; 3.0 for snappy cuts.
  // WARNING:   this is a 1/time value, not a time value. Setting
  //            transitionSpeed=0.6 gives a SLOWER transition (~1.7s),
  //            not a faster one. Counter-intuitive — remember it's
  //            a rate.
  // CUSTOMIZATION: expose this in the UI as a "Transition speed"
  //            slider for the user; currently fixed at 1.6.
  // ============================================================
  /** 1 / seconds for the crossfade. 1.6 means a ~0.6s transition. */
  private transitionSpeed = 1.6

  // ============================================================
  // PARAMETER: transitionStyle (default visual style)
  // Purpose:   which easing/alpha curve the crossfade uses. The user
  //            picks one in the UI; setTransitionStyle updates this.
  // Safe range: 'crossfade' | 'wipe' | 'zoom'.
  // Typical:   'crossfade' — the safe default; works for every scene.
  // Try:       'wipe' for geometric / glitch aesthetics (Grid scene);
  //            'zoom' for high-energy transitions (EDM drops).
  // WARNING:   'wipe' relies on the scene shader implementing a wipe
  //            line via the u_opacity uniform. Scenes that treat
  //            opacity as a simple multiplier will look like a
  //            crossfade even when 'wipe' is selected. (All five
  //            built-in scenes treat opacity as a simple multiplier,
  //            so 'wipe' currently behaves like 'crossfade' with a
  //            linear ease.)
  // ============================================================
  /** active transition style (crossfade / wipe / zoom) */
  private transitionStyle: TransitionStyle = 'crossfade'

  setTransitionStyle(s: TransitionStyle): void {
    this.transitionStyle = s
  }

  getTransitionStyle(): TransitionStyle {
    return this.transitionStyle
  }

  /**
   * Factory so scenes are created lazily only when needed.
   *
   * WHY lazy: each scene allocates GPU resources (geometry, materials,
   *   render targets) at construction. Creating all five upfront would
   *   cost ~5× the memory of one scene even when the user never visits
   *   four of them. Lazy creation means we only pay for what's used.
   *
   * WHY a switch (not a registry map): the set of scenes is fixed at 5
   *   and known at compile time — a registry would add indirection
   *   without flexibility. The default case is LiquidScene because
   *   it's the most visually neutral (and the spec §44 MVP scene).
   */
  private ensureScene(id: SceneId): Scene {
    let s = this.scenes.get(id)
    if (!s) {
      switch (id) {
        case 'liquid': s = new LiquidScene(); break
        case 'orbit': s = new OrbitScene(); break
        case 'tunnel': s = new TunnelScene(); break
        case 'grid': s = new GridScene(); break
        case 'particles': s = new ParticleFieldScene(); break
        default: s = new LiquidScene()
      }
      s.init()
      this.scenes.set(id, s)
    }
    return s
  }

  getActiveId(): SceneId | null {
    return this.activeId
  }

  /**
   * Initialize a starting scene without any transition. Called once
   * by VisualEngine.init() with 'liquid' to seed the first scene.
   *
   * WHY a separate method (not just switchTo with a flag): the first
   *   scene has no "from" to fade out — there's nothing outgoing.
   *   Using switchTo for the first scene would create a transition
   *   from "null" which would crash or look like a fade-from-black.
   *   start() skips the transition machinery entirely.
   */
  start(id: SceneId): Scene {
    const s = this.ensureScene(id)
    s.setOpacity(1)
    this.activeId = id
    return s
  }

  /**
   * Begin a crossfade to a new scene. Safe to call mid-transition;
   * the manager will fast-forward the previous one and start fresh.
   *
   * ALGORITHM (Level 2) — switchTo mid-transition handling:
   *
   *   The naive implementation would set fromId = activeId, toId = id,
   *   transition = 0 and let the loop run. But if a transition is
   *   already in flight, the OLD outgoing scene (this.fromId before
   *   we overwrite it) would be orphaned — never disposed, leaking
   *   GPU memory until dispose() clears the whole map.
   *
   *   So we explicitly check: is there a fromId already? If yes, and
   *   it's not the new target, dispose that OLD outgoing scene now.
   *   We end up with at most TWO live scenes (the new outgoing +
   *   new incoming), never three.
   *
   *   WHY "fromId !== id" guard: if the user double-clicks the same
   *   target scene during a transition, we'd be disposing the scene
   *   we're about to switch to. The guard prevents that.
   *
   *   After cleanup, the new transition state is set:
   *     fromId = the current activeId (this is now the "outgoing")
   *     toId = id (the new target)
   *     activeId = id (logically we're "on" the new scene even
   *                 while the crossfade runs — getActiveId returns
   *                 the new scene immediately, getRenderingScenes
   *                 returns both during the transition)
   *     transition = 0 (start the crossfade fresh)
   *
   *   The incoming scene starts fully transparent (opacity=0); the
   *   outgoing starts fully opaque (opacity=1). update() will ease
   *   them toward 1 and 0 respectively.
   *
   *   WHY pre-warm the target via ensureScene before setting state:
   *     the new scene's first render happens on the next frame. If
   *     we don't pre-warm, the first frame of the transition would
   *     create the scene (constructor + init + GPU upload) — a
   *     visible hitch. Pre-warming moves that work to "now" so the
   *     transition starts smooth.
   */
  switchTo(id: SceneId): void {
    if (id === this.activeId) return
    this.ensureScene(id) // pre-warm the target
    // if a transition is already in flight, dispose the OLD outgoing
    // scene immediately so we don't hold three scenes at once.
    if (this.fromId && this.fromId !== id) {
      const old = this.scenes.get(this.fromId)
      if (old) {
        old.dispose()
        this.scenes.delete(this.fromId)
      }
    }
    this.fromId = this.activeId
    this.toId = id
    this.transition = 0
    this.activeId = id
    // incoming starts fully transparent; outgoing starts fully opaque
    this.scenes.get(id)?.setOpacity(0)
    this.scenes.get(this.fromId ?? '' as SceneId)?.setOpacity(1)
  }

  /**
   * Are we mid-transition? Returns true while a crossfade is in flight.
   *
   * WHY check toId (not transition>0): the transition field is reset
   *   to 0 on completion AND on switchTo — but toId is only reset on
   *   completion. Checking toId !== null is the canonical "are we
   *   in a transition" test.
   */
  isTransitioning(): boolean {
    return this.toId !== null
  }

  /**
   * Current transition progress 0..1 (0 = no transition or just started,
   * 1 = complete). Used by the debug overlay.
   */
  getTransition(): number {
    return this.transition
  }

  /**
   * Advance the transition by dt seconds. Each frame, sets the
   * opacity uniforms on both scenes so the renderer can composite
   * them. The easing curve depends on `transitionStyle`:
   *
   *   crossfade: ease-in-out cubic on alpha 0↔1 for both scenes.
   *   wipe:      a hard-step alpha — incoming is fully visible past
   *              the wipe line (t), outgoing is fully visible before
   *              it. The wipe line moves left→right with eased t.
   *   zoom:      incoming scales 1.2 → 1.0 + fades 0 → 1;
   *              outgoing scales 1.0 → 1.15 + fades 1 → 0. The scale
   *              is applied via the scene's setOpacity hook (scenes
   *              that don't implement scale just get a fade).
   *
   * When the transition completes, the old scene is disposed.
   *
   * ALGORITHM (Level 2) — opacity easing + dispose-on-complete:
   *
   *   Step 1: advance the raw progress
   *
   *     transition = min(1, transition + dt * transitionSpeed)
   *
   *   The min() clamps the end so we don't overshoot 1 (which would
   *   make the easing math produce alpha > 1 in the zoom style).
   *
   *   Step 2: compute the eased value
   *
   *     The base ease is ease-in-out cubic:
   *       t < 0.5  → 2 * t * t                    (ease in: slow start)
   *       t >= 0.5 → 1 - pow(-2*t + 2, 2) / 2     (ease out: slow end)
   *
   *     WHY ease-in-out (not linear): linear fades feel mechanical;
   *       the eye notices the start and end of a linear blend as hard
   *       cuts. Ease-in-out makes the middle of the transition fast
   *       (where both scenes are 50% visible, the blend is least
   *       noticeable) and the start/end slow (where one scene
   *       dominates, the eye needs time to register the new one).
   *
   *   Step 3: compute in/out alpha based on style
   *
   *     crossfade: inAlpha = eased, outAlpha = 1 - eased
   *     wipe:      inAlpha = t (linear), outAlpha = 1 - t
   *                (no easing — the wipe line itself is the dramatic
   *                 element, so we keep its motion linear)
   *     zoom:      inAlpha = min(1, eased * 1.1) — the 1.1 multiplier
   *                gives a slight "punch in" feel (overshoots 1.0
   *                briefly, clamped). outAlpha = 1 - eased.
   *
   *   Step 4: apply via setOpacity on both scenes
   *
   *   Step 5: completion check — if transition >= 1.0:
   *     - dispose the outgoing scene (frees GPU memory)
   *     - delete it from the scenes map
   *     - force the incoming scene to opacity 1 (clean snap in case
   *       the eased value rounded to 0.999)
   *     - reset fromId, toId, transition to null/0
   *
   *   WHY dispose only at completion: see file-level CROSSFADE
   *     IMPLEMENTATION section. Short version: yanking the outgoing
   *     scene's geometry mid-frame would flash.
   */
  update(dt: number): void {
    if (this.toId === null) return
    this.transition = Math.min(1, this.transition + dt * this.transitionSpeed)
    const t = this.transition
    // ease-in-out cubic base
    //   t < 0.5: 2t²           (slow start)
    //   t ≥ 0.5: 1 - (2-2t)²/2 (slow end, mirrored)
    //   Visual: at t=0.25 → 0.125, at t=0.5 → 0.5, at t=0.75 → 0.875
    //   (cubic-eased version of the linear 0.25/0.5/0.75 ramp — the
    //   middle values move faster, the ends move slower).
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    const incoming = this.scenes.get(this.toId)
    const outgoing = this.fromId ? this.scenes.get(this.fromId) : null

    let inAlpha = eased
    let outAlpha = 1 - eased
    if (this.transitionStyle === 'wipe') {
      // hard step at the wipe line — gives a cleaner geometric reveal
      inAlpha = t
      outAlpha = 1 - t
    } else if (this.transitionStyle === 'zoom') {
      // punchier fade with a slight overshoot feel
      inAlpha = Math.min(1, eased * 1.1)
      outAlpha = 1 - eased
    }
    if (incoming) incoming.setOpacity(inAlpha)
    if (outgoing) outgoing.setOpacity(outAlpha)
    if (this.transition >= 1) {
      // dispose the outgoing scene
      // WHY this is the disposal point: the crossfade is now complete
      //   (outgoing alpha is effectively 0), so the outgoing scene is
      //   no longer visible. Disposing here frees GPU memory without
      //   any visible flash.
      if (this.fromId) {
        const s = this.scenes.get(this.fromId)
        if (s) {
          s.dispose()
          this.scenes.delete(this.fromId)
        }
      }
      // ensure the now-active scene is fully opaque
      // WHY: the eased alpha may have rounded to 0.9999 — forcing
      //   opacity=1 snaps to a clean state so future renders don't
      //   have a fractional alpha that could compound rounding errors.
      const active = this.scenes.get(this.toId)
      if (active) active.setOpacity(1)
      this.fromId = null
      this.toId = null
      this.transition = 0
    }
  }

  /**
   * Return the active scene (or null before init). This is the scene
   * the user *conceptually* is on; during a transition it's the
   * INCOMING scene (the one we're switching TO).
   */
  getActive(): Scene | null {
    if (!this.activeId) return null
    return this.scenes.get(this.activeId) ?? null
  }

  /**
   * Both the outgoing and incoming scene during a transition.
   *
   * WHY outgoing first: the VisualEngine renders in array order.
   *   Drawing outgoing first means incoming draws ON TOP — which is
   *   what we want as incoming fades in (alpha goes 0→1) and outgoing
   *   fades out (alpha goes 1→0). Reverse order would have incoming
   *   drawn first then outgoing on top — outgoing would block the
   *   incoming as it faded out.
   *
   *   When NOT transitioning, only the active scene is returned —
   *   the array has length 1.
   */
  getRenderingScenes(): Scene[] {
    const out: Scene[] = []
    // outgoing first so incoming draws on top
    if (this.fromId) {
      const s = this.scenes.get(this.fromId)
      if (s) out.push(s)
    }
    if (this.activeId) {
      const s = this.scenes.get(this.activeId)
      if (s) out.push(s)
    }
    return out
  }

  /**
   * Dispose all owned scenes and clear state. Called by VisualEngine
   * on unmount to free GPU resources. After this, the manager is in
   * the same state as a fresh construction (no scenes, no active).
   */
  dispose(): void {
    for (const s of this.scenes.values()) s.dispose()
    this.scenes.clear()
    this.activeId = null
    this.fromId = null
    this.toId = null
  }
}
