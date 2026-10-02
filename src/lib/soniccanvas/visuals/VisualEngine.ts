import * as THREE from 'three'
import { SceneManager } from './SceneManager'
import { VisualMapper } from './VisualMapper'
import { AutoSceneController } from './AutoSceneController'
import type { MappingCurve, MappingKey } from './MappingCurves'
import { AudioAnalyzer } from '../audio/AudioAnalyzer'
import { AudioEngine } from '../audio/AudioEngine'
import type { UserSettings } from '../audio/types'

/**
 * RenderStats — per-frame statistics published to subscribers via onStats().
 *
 * Consumed by the debug overlay / FPS counter UI. The VisualEngine calls
 * notifyStats() at the end of every frame with a fresh object.
 */
export interface RenderStats {
  /** measured frames-per-second (updated twice per second) */
  fps: number
  /** internal drawing buffer width (post-DPR, post-quality-scale) */
  width: number
  /** internal drawing buffer height */
  height: number
  /** id of the active scene, or null before init() */
  scene: string | null
  /** true while a crossfade is in flight */
  transitioning: boolean
  /** transition progress 0..1 (0 = no transition, 1 = complete) */
  transition: number
}

/**
 * ============================================================================
 * MODULE: VisualEngine — owns the render loop, the renderer, the FPS scaler
 * ============================================================================
 *
 * WHAT IT IS
 *   The top-level "graphics" object for SonicCanvas. It owns the
 *   WebGLRenderer + canvas, the SceneManager (which owns scenes), the
 *   VisualMapper (audio→visual), the AudioAnalyzer (per-frame FFT), and
 *   the AutoSceneController (energy-based scene rotation). It runs the
 *   requestAnimationFrame loop that ties everything together.
 *
 * WHY IT EXISTS
 *   Something has to own the rAF loop, the WebGL context, the resize
 *   handler, the perf scaler, and the cross-cutting glue between audio
 *   analysis and visual rendering. The React layer (page.tsx + hooks)
 *   owns the *lifecycle* (create on mount, dispose on unmount); the
 *   VisualEngine owns the *per-frame work* and the GPU resources.
 *
 *   Separating these concerns is what lets the same engine drive both
 *   the live preview AND the WebM exporter — the exporter calls the same
 *   methods (setExportActive, resizeTo, the loop's bodies via manual
 *   stepping) but at its own resolution and frame rate.
 *
 * WHAT GOES IN
 *   - HTMLCanvasElement (created by React, passed in constructor)
 *   - AudioEngine (the audio source + master clock; passed in constructor)
 *   - UserSettings (set via setSettings; updated when the store changes)
 *   - User intent:
 *       setScene(id)           — manual scene change
 *       setAutoSceneMode(bool) — toggle energy-based auto-switching
 *       setTransitionStyle(s)  — crossfade / wipe / zoom
 *       setMappingCurves(c)   — from the mapping editor
 *       setSoloFeature(f)      — solo a feature in the mapper
 *       setExportActive(b)    — pause the FPS scaler during export
 *       resizeTo(w, h)         — force a specific export resolution
 *
 * WHAT COMES OUT
 *   - Rendered pixels on the canvas (every frame)
 *   - RenderStats via onStats() subscribers (twice per second)
 *   - getCanvas() / getRenderer() for the exporter to capture the stream
 *   - getAnalyzer() / getManager() / getAutoScene() for the UI to wire in
 *
 * WHAT DEPENDS ON IT
 *   - page.tsx (instantiates it in a useEffect, owns the canvas ref)
 *   - The WebM exporter (calls setExportActive + resizeTo + reads the canvas)
 *   - The debug overlay (subscribes to onStats and reads getLatestFeatures)
 *   - The settings UI (calls setSettings on every store change)
 *
 * WHAT IT DEPENDS ON
 *   - three (THREE.WebGLRenderer, WebGL2 context)
 *   - SceneManager (owns scenes + transitions)
 *   - VisualMapper (audio → VisualState)
 *   - AutoSceneController (energy-based scene rotation)
 *   - AudioAnalyzer + AudioEngine (per-frame audio features + master clock)
 *
 * THE MASTER CLOCK (spec §26)
 *
 *   The visual timeline is driven by the *audio playback position*, NOT
 *   by wall-clock time. This is critical for two reasons:
 *
 *     1. Determinism for export. The WebM exporter captures frames at its
 *        own rate; if visuals depended on wall-clock time, the exported
 *        video would drift out of sync with the audio track. By using
 *        audio.getCurrentTime() as the time base, the same audio + same
 *        settings produce the same visuals every time.
 *
 *     2. Seek/pause correctness. When the user seeks, audio time jumps;
 *        visuals jump with it. When the user pauses, audio time freezes;
 *        visuals freeze too (the loop still runs, but scenes see a
 *        constant `audioTime` so procedural animation that depends on
 *        time halts — except where scenes use dt internally for movement,
 *        which is intentional so the scene keeps breathing).
 *
 *   The rAF callback receives a wall-clock `now`, but we only use it to
 *   compute `dt` (for FPS measurement and scene motion). The *visual*
 *   time sent to scenes is `audioTime = audio.getCurrentTime()`.
 *
 * THE RENDER LOOP (per frame)
 *
 *   requestAnimationFrame(loop)
 *        │
 *        │  1. compute dt from wall-clock `now`
 *        ▼
 *   measure FPS (every ~0.5s)  ──>  tickAutoScaler (step quality up/down)
 *        │
 *        │  2. master clock: audio.getCurrentTime() / getDuration()
 *        ▼
 *   lazy re-attach analyser if AudioEngine just created it
 *        │
 *        │  3. analyzer.update(audioTime, duration)  ──>  AudioFeatures
 *        ▼
 *   mapper.map(features, settings)               ──>  VisualState
 *        │
 *        │  4. manager.update(dt)  (advances any in-flight transition)
 *        ▼
 *   autoScene.observe(audioTime, energy, beatPulse)  (if not transitioning)
 *        │
 *        │  5. clear canvas to settings.backgroundColor
 *        ▼
 *   for each active scene (1 normally, 2 during crossfade):
 *        scene.update(visualState, settings, audioTime)
 *        scene.render(renderer)
 *        │
 *        ▼
 *   notifyStats()  ──>  subscribers (debug overlay)
 *
 *   Step 1 (dt): if the engine was just started (lastFrame=0), assume
 *   1/60s to avoid a giant first-frame dt that would lurch everything.
 *
 *   Step 2 (lazy analyser re-attach): the AudioEngine creates its
 *   AnalyserNode lazily — only after the user has loaded a file and the
 *   AudioContext has resumed. The VisualEngine may have started before
 *   that (e.g. the page renders an empty canvas first, the user picks a
 *   file later). Rather than require the React layer to call attach(),
 *   we lazily try to attach on every frame until it sticks. See the
 *   detailed comment in loop() for why this is the right pattern.
 *
 *   Step 5 (clear + render both scenes during a transition): the canvas
 *   is cleared to the user's backgroundColor so crossfading scenes
 *   composite over a known base. Both the outgoing and incoming scene
 *   are rendered with NormalBlending — the SceneManager has already set
 *   their opacity uniforms to (1-t) and (t) respectively.
 *
 * THE FPS AUTO-SCALER (spec §28)
 *
 *   To keep the live preview smooth on slow GPUs, the engine lowers its
 *   internal render resolution when FPS drops, and raises it when FPS
 *   is comfortably high. The algorithm:
 *
 *     - every ~0.5s: fps = frames / elapsed
 *     - if fps < fpsFloor (45): increment lowFpsTimer; if it reaches
 *       downscaleAfter (3.0s), step quality DOWN one notch and reset
 *     - if fps >= fpsCeil (57): increment highFpsTimer; if it reaches
 *       upscaleAfter (6.0s), step quality UP one notch and reset
 *     - else (hysteresis band 45..57): reset both timers
 *
 *   Quality steps are discrete: [0.5, 0.75, 1.0]. We step one notch at a
 *   time so the visual change is gradual rather than a sudden jump.
 *
 *   WHY a hysteresis band (45..57, not just "< 50"): without the dead
 *   zone, FPS hovering near the threshold would cause oscillation —
 *   step down, FPS recovers, step up, FPS drops, step down... The 12-FPS
 *   gap between floor and ceil means we only step down on sustained low
 *   FPS and only step up on sustained high FPS.
 *
 *   WHY timers instead of immediate reaction (3s/6s): one bad frame
 *   shouldn't tank the resolution. The 3s threshold for downscale means
 *   we tolerate ~180 consecutive bad frames before reacting; the 6s
 *   threshold for upscale is double because *raising* resolution is
 *   riskier (a single drop after upscale costs a frame, then we're back
 *   to scaling down again).
 *
 *   WHY disabled during export: the exporter sets its own fixed
 *   resolution (resizeTo) and runs at its own frame rate. If the
 *   scaler kicked in mid-export, the captured video would have
 *   inconsistent resolution between frames.
 *
 *   WHY `lowFpsTimer += 0.5` (not += dt): tickAutoScaler is called
 *   every ~0.5s from the loop, so we know the cadence. Using a constant
 *   keeps the comparison against downscaleAfter/upscaleAfter exact
 *   regardless of how the FPS measurement interval drifts.
 *
 * ============================================================================
 */
export class VisualEngine {
  // ──── owned resources ─────────────────────────────────────────────
  private canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private manager: SceneManager
  private mapper: VisualMapper
  private analyzer: AudioAnalyzer
  private audio: AudioEngine
  private autoScene: AutoSceneController

  // ──── render loop state ───────────────────────────────────────────
  // WHY `rafId` is a number (not null): cancelAnimationFrame is a no-op
  //   with id 0 / -1, and we check `running` before scheduling the next
  //   frame. Keeping it as a plain number avoids null-check branches.
  private rafId = 0
  private running = false
  // WHY lastFrame starts at 0 (not Date.now()): 0 is a sentinel for
  //   "first frame". In loop() we check `if (this.lastFrame)` and assume
  //   1/60s for the first dt — otherwise the first dt would be the time
  //   since process start, which can be huge and lurch the scene.
  private lastFrame = 0
  // FPS counters: fpsAcc accumulates dt, fpsCount accumulates frames,
  // fpsTimer counts toward the next 0.5s measurement window.
  private fps = 0
  private fpsAcc = 0
  private fpsCount = 0
  private fpsTimer = 0

  // ──── internal render resolution scale (lower on slow devices) ────
  // dpr    = devicePixelRatio clamp at 2 (high-DPI screens don't get
  //          more than 2x — diminishing returns + bandwidth cost).
  // quality = additional manual multiplier 0.5..1.0 set by the
  //           auto-scaler (or manually by setQuality).
  // Final buffer = cssW * dpr * quality × cssH * dpr * quality.
  private dpr = 1
  // ============================================================
  // PARAMETER: quality (initial internal render scale)
  // Purpose:   multiplier on the device-pixel-ratio-scaled buffer size.
  //            1.0 = render at full DPR; <1 = render smaller, upscale
  //            via CSS for a perf boost at the cost of sharpness.
  // Safe range: 0.25 .. 1.0  (anything below 0.25 looks like mud).
  // Typical:   1.0 — start at full quality; the auto-scaler lowers it
  //            if FPS drops. setQuality() clamps to [0.25, 1].
  // Try:       0.75 for a perf-constrained device; 0.5 for a 4K screen
  //            where DPR=2 alone would be a 4× perf hit.
  // WARNING:   this is the *starting* quality only — tickAutoScaler
  //            will move it to one of the qualitySteps values on the
  //            first sustained low-FPS window.
  // ============================================================
  private quality = 1.0 // 1.0 = full, 0.75/0.5 = lower

  /**
   * FPS auto-scaler state (spec §28 — performance scaling). When FPS
   * stays below `fpsFloor` for `downscaleAfter` seconds, we lower the
   * internal render quality. When FPS stays above `fpsCeil` for
   * `upscaleAfter` seconds, we raise it back. Clamps to [minQuality, 1].
   * Disabled while an export is in progress (export sets its own size).
   */
  private autoScaleEnabled = true

  // ============================================================
  // PARAMETER: fpsFloor (downscale trigger)
  // Purpose:   measured FPS below this for `downscaleAfter` seconds
  //            triggers a quality step DOWN. Sets the lower bound of
  //            the scaler's hysteresis band.
  // Safe range: 20 .. 50 fps.
  // Typical:   45 — anything below 45 looks visibly stuttery to most
  //            users (60fps monitor → drop every 4th frame).
  // Try:       30 for a "smooth-enough" target on low-end devices;
  //            55 to react earlier (more aggressive downscaling).
  // WARNING:   must be < fpsCeil with at least a 5-FPS gap or the
  //            hysteresis band collapses and the scaler oscillates.
  // ============================================================
  private readonly fpsFloor = 45

  // ============================================================
  // PARAMETER: fpsCeil (upscale trigger)
  // Purpose:   measured FPS >= this for `upscaleAfter` seconds triggers
  //            a quality step UP. Sets the upper bound of the hysteresis
  //            band.
  // Safe range: 40 .. 60 fps (must exceed fpsFloor).
  // Typical:   57 — at 60fps display, this means "we have headroom to
  //            spend pixels on sharpness". 60 is the rAF cap on most
  //            displays so we want a small margin below it.
  // Try:       50 for less aggressive upscaling (stay at lower quality
  //            longer); 59 for max opportunism.
  // ============================================================
  private readonly fpsCeil = 57

  // ============================================================
  // PARAMETER: downscaleAfter (sustained-low-FPS window before step down)
  // Purpose:   how many seconds of sustained low FPS before we lower
  //            quality. Prevents one bad frame from tanking the
  //            resolution — we need a real, sustained dip.
  // Safe range: 1.0 .. 10.0 seconds.
  // Typical:   3.0 — at 60fps that's ~180 bad frames, enough to be sure
  //            it's a real slowdown not a momentary GC stall.
  // Try:       1.0 for hyper-reactive downscaling (instant quality drop
  //            on slow frame); 8.0 for very conservative (tolerate long
  //            slowdowns before reducing quality).
  // WARNING:   too short and the scaler will thrash on every minor
  //            GC stall; too long and a sustained slowdown becomes a
  //            multi-second stutter before relief.
  // ============================================================
  private readonly downscaleAfter = 3.0 // seconds of low FPS before stepping down

  // ============================================================
  // PARAMETER: upscaleAfter (sustained-high-FPS window before step up)
  // Purpose:   how many seconds of sustained high FPS before we raise
  //            quality. Doubled vs downscaleAfter because raising
  //            quality is riskier (one drop after the bump costs a frame
  //            and we end up scaling down again).
  // Safe range: 2.0 .. 15.0 seconds.
  // Typical:   6.0 — twice the downscale window. Conservative about
  //            spending pixels we just regained.
  // Try:       3.0 for snappier recovery; 10.0 to stay downscaled longer.
  // WARNING:   lowering this too far causes the same thrash as a too-
  //            short downscaleAfter — the resolution ping-pongs.
  // ============================================================
  private readonly upscaleAfter = 6.0 // seconds of high FPS before stepping up

  // ============================================================
  // PARAMETER: minQuality (lowest the scaler will go)
  // Purpose:   absolute floor on the quality multiplier. Even if FPS
  //            stays below fpsFloor forever, we never render below this
  //            — the result would be visually broken (giant texels).
  // Safe range: 0.25 .. 0.75.
  // Typical:   0.5 — corresponds to the lowest entry in qualitySteps.
  // Try:       0.25 for extreme low-end devices (matches setQuality's
  //            hard clamp); 0.75 to keep a quality floor.
  // WARNING:   must be >= qualitySteps[0] or stepQuality(-1) will
  //            clamp to a higher value than this floor promises.
  // ============================================================
  private readonly minQuality = 0.5

  // ============================================================
  // PARAMETER: qualitySteps (discrete quality levels)
  // Purpose:   the resolution notches the scaler moves between. We
  //            step one notch at a time so the visual change is
  //            gradual rather than a sudden jump.
  // Safe range: 2 .. 5 entries; values in [0.25, 1.0]; must be sorted
  //            ascending and include 1.0 so we can recover full quality.
  // Typical:   [0.5, 0.75, 1.0] — three notches is enough granularity.
  // Try:       [0.5, 1.0] for a binary "low / high" toggle;
  //            [0.25, 0.5, 0.75, 1.0] for finer control.
  // WARNING:   stepQuality uses indexOf to find the current step. If
  //            you put duplicate values in here, indexOf returns the
  //            first match — the step direction can land wrong.
  // ============================================================
  private readonly qualitySteps = [0.5, 0.75, 1.0]

  // Timers that accumulate the 0.5s ticks where FPS was low / high.
  private lowFpsTimer = 0
  private highFpsTimer = 0
  // WHY exportActive pauses the scaler: the exporter calls resizeTo
  //   to set a specific output resolution and runs frames at its own
  //   pace. If the scaler kicked in mid-export, the captured video
  //   would have inconsistent resolution between frames.
  private exportActive = false

  // WHY a Set (not array) for stats listeners: subscribers unsubscribe
  //   by identity; Set.delete is O(1). Order is irrelevant for stats.
  private statsListeners = new Set<(s: RenderStats) => void>()

  /**
   * Construct the engine. Creates the WebGLRenderer and the helper
   * subsystems (analyzer, mapper, sceneManager, autoScene). Does NOT
   * start the render loop — call start() after init().
   *
   * WHY both `getContext('webgl2', ...)` AND `new WebGLRenderer({context})`:
   *   Three's WebGLRenderer accepts an existing context. Passing it
   *   explicitly lets us set the attributes we care about (alpha:false,
   *   antialias:false, preserveDrawingBuffer:true for captureStream,
   *   powerPreference:'high-performance') in one place. If we let
   *   Three create the context, we'd have to mirror the attributes in
   *   the WebGLRenderer constructor too — same attributes, two places.
   *
   * WHY preserveDrawingBuffer:true: required for canvas.captureStream()
   *   to grab the rendered frame for WebM export. The perf cost is real
   *   (the GPU can't trivially discard the back buffer after swap) but
   *   we pay it always because export can be triggered at any time.
   *
   * WHY alpha:false + antialias:false: alpha=false lets the GPU skip
   *   the alpha-blend pass on the clear. antialias=false because every
   *   scene uses a full-screen shader pass; MSAA on a shader output is
   *   wasted work — the shader already samples per-pixel.
   */
  constructor(canvas: HTMLCanvasElement, audio: AudioEngine) {
    this.canvas = canvas
    this.audio = audio
    this.analyzer = new AudioAnalyzer()
    this.mapper = new VisualMapper()
    this.manager = new SceneManager()
    this.autoScene = new AutoSceneController()
    // Circular reference: AutoSceneController needs to call back into
    // the engine to trigger scene switches. We break the cycle by
    // injecting the engine post-construction rather than passing it in
    // the AutoSceneController constructor (which would require
    // `this` before super() returns).
    this.autoScene.setVisualEngine(this)

    const ctx = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true, // needed for captureStream
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: ctx,
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    // WHY a dark clear color default: the canvas is shown before any
    //   settings have been applied (during the very first paint). A
    //   near-black with a faint purple tint matches the SonicCanvas
    //   aesthetic so the empty canvas doesn't look like a bug.
    this.renderer.setClearColor(0x05030d, 1)
  }

  // ──── accessors (used by React / exporter / UI) ───────────────────

  getAnalyzer(): AudioAnalyzer {
    return this.analyzer
  }

  getManager(): SceneManager {
    return this.manager
  }

  getAutoScene(): AutoSceneController {
    return this.autoScene
  }

  setAutoSceneMode(enabled: boolean): void {
    this.autoScene.setEnabled(enabled)
  }

  setTransitionStyle(style: 'crossfade' | 'wipe' | 'zoom'): void {
    this.manager.setTransitionStyle(style)
  }

  setMappingCurves(curves: Record<MappingKey, MappingCurve>): void {
    this.mapper.setCurves(curves)
  }

  setSoloFeature(f: MappingKey | null): void {
    this.mapper.setSoloFeature(f)
  }

  /**
   * Initialize the engine with the first UserSettings. Must be called
   * before start(). Attaches the analyzer to the audio engine's
   * analyser node, applies the initial clear color, and starts the
   * default scene.
   *
   * WHY this is separate from the constructor: the constructor must
   *   stay cheap (React creates the engine in a useEffect; a slow
   *   constructor delays first paint). init() does the work that
   *   depends on settings / audio being ready — which happens after
   *   the constructor returns.
   *
   * WHY the analyzer.attach() may silently no-op: if the user hasn't
   *   loaded a file yet, audio.getAnalyser() returns null. We skip the
   *   attach; the lazy re-attach in loop() will pick it up later.
   */
  init(settings: UserSettings): void {
    // attach analyzer to the audio engine's analyser node
    const an = this.audio.getAnalyser()
    if (an) this.analyzer.attach(an)
    // apply initial background clear color
    this.renderer.setClearColor(settings.backgroundColor, 1)
    // start with the default scene
    this.manager.start('liquid')
    this.resize()
  }

  /**
   * Manually set the render quality multiplier (clamped 0.25..1.0) and
   * re-apply the resize. Bypasses the auto-scaler — useful for a UI
   * "Quality" dropdown that lets the user override the auto choice.
   *
   * WHY clamp at 0.25: below that the internal buffer is so small that
   *   GLSL uniforms like sampler2D start sampling outside their
   *   intended UV range — the result is visual garbage. 0.25 is the
   *   empirical floor.
   */
  setQuality(q: number): void {
    this.quality = Math.max(0.25, Math.min(1, q))
    this.resize()
  }

  /**
   * Pause the FPS auto-scaler during an export (the exporter sets its
   * own target resolution and we don't want to fight it).
   *
   * WHY reset the timers when active goes true: a long export run might
   *   have happened during a low-FPS period (exporter runs slower than
   *   real-time). Without resetting the timers, the very next
   *   tickAutoScaler call after the export would immediately fire a
   *   step-down — we'd downgrade based on stale FPS history.
   */
  setExportActive(active: boolean): void {
    this.exportActive = active
    if (active) {
      // reset timers so we don't trigger a step immediately after export
      this.lowFpsTimer = 0
      this.highFpsTimer = 0
    }
  }

  /**
   * One tick of the FPS auto-scaler. Called ~twice per second from the
   * main loop (every 0.5s when fpsTimer overflows). Steps the internal
   * render quality up or down to keep FPS in a comfortable range.
   *
   * ALGORITHM (Level 2) — hysteresis-band FPS scaler:
   *
   *   The measured FPS lives in one of three bands:
   *
   *     fps < fpsFloor (45)      → "low"     lowFpsTimer += 0.5
   *     fps >= fpsCeil (57)      → "high"    highFpsTimer += 0.5
   *     fpsFloor <= fps < fpsCeil → "dead zone"  reset both timers
   *
   *   When lowFpsTimer reaches downscaleAfter (3s) → step quality DOWN.
   *   When highFpsTimer reaches upscaleAfter (6s) → step quality UP.
   *   After either step, reset the relevant timer.
   *
   *   WHY a dead zone: without it, FPS hovering near the threshold
   *   would oscillate (down, up, down, up). The dead zone means we
   *   only react to *clearly* low or *clearly* high FPS — anything
   *   in between is "fine, leave it alone".
   *
   *   WHY 0.5 increments: this method is called every ~0.5s from
   *   loop(), so incrementing by 0.5 means each call counts as 0.5s
   *   exactly. Using dt would accumulate rounding errors; a fixed
   *   tick keeps the comparison against the threshold exact.
   *
   *   WHY early-return on exportActive: the exporter sets its own
   *   fixed resolution (resizeTo) and runs at its own pace. Letting
   *   the scaler override that mid-export would produce a video with
   *   inconsistent resolution between frames.
   *
   *   WHY early-return on fps<=0: before the first 0.5s window
   *   completes, fps is still 0 — dividing by that would give NaN or
   *   Infinity. Skip until we have a real measurement.
   */
  private tickAutoScaler(): void {
    if (!this.autoScaleEnabled || this.exportActive) return
    if (this.fps <= 0) return
    if (this.fps < this.fpsFloor) {
      this.lowFpsTimer += 0.5
      this.highFpsTimer = 0
      if (this.lowFpsTimer >= this.downscaleAfter) {
        this.stepQuality(-1)
        this.lowFpsTimer = 0
      }
    } else if (this.fps >= this.fpsCeil) {
      this.highFpsTimer += 0.5
      this.lowFpsTimer = 0
      if (this.highFpsTimer >= this.upscaleAfter) {
        this.stepQuality(+1)
        this.highFpsTimer = 0
      }
    } else {
      // hysteresis band — reset both timers
      this.lowFpsTimer = 0
      this.highFpsTimer = 0
    }
  }

  /**
   * Step the quality multiplier by one notch in the given direction.
   * Finds the current quality in qualitySteps, moves by `direction`,
   * clamps to the array bounds, and applies via resize().
   *
   * WHY indexOf with a fallback to the last step: if the user
   *   manually called setQuality(0.6) (a value not in qualitySteps),
   *   indexOf returns -1. We treat that as "we're at the top step"
   *   so a step-down from a non-standard value lands on the highest
   *   standard step below current. A step-up from a non-standard
   *   value is a no-op (we're already past the top).
   */
  private stepQuality(direction: 1 | -1): void {
    const idx = this.qualitySteps.indexOf(this.quality)
    const cur = idx < 0 ? this.qualitySteps.length - 1 : idx
    const next = Math.max(0, Math.min(this.qualitySteps.length - 1, cur + direction))
    const nextQ = this.qualitySteps[next]
    if (nextQ !== this.quality) {
      this.quality = nextQ
      this.resize()
    }
  }

  getQuality(): number {
    return this.quality
  }

  /**
   * Resize the drawing buffer to match the canvas's parent element,
   * honoring the device pixel ratio (clamped to 2) and the current
   * quality multiplier. Called on window resize, on quality changes,
   * and on init.
   *
   * WHY clientWidth/Height with window.innerWidth fallback: the canvas
   *   is sized by its parent (CSS). If the parent isn't sized yet (e.g.
   *   during initial layout), clientWidth is 0 — we fall back to the
   *   viewport so the engine doesn't render into a 0×0 buffer (which
   *   would crash the GL framebuffer state).
   *
   * WHY dpr clamped at 2: high-DPI phones report DPR=3 or 4. Rendering
   *   at 4× the CSS pixels is 16× the fillrate — most GPUs can't keep
   *   60fps at that resolution. 2 is the perceptual sweet spot.
   */
  resize(): void {
    const parent = this.canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth || window.innerWidth
    const h = parent.clientHeight || window.innerHeight
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    const scale = this.dpr * this.quality
    const width = Math.max(1, Math.floor(w * scale))
    const height = Math.max(1, Math.floor(h * scale))
    this.applySize(w, h, width, height)
  }

  /**
   * Force the renderer to a specific pixel size (for high-resolution
   * export). The CSS size of the canvas remains unchanged so the
   * preview UI doesn't jump; only the internal drawing buffer grows.
   * Call `resize()` afterwards to restore the parent-driven size.
   *
   * WHY dpr=1 here: the exporter wants exact pixel dimensions (e.g.
   *   1920×1080). Multiplying by DPR would give a different actual
   *   buffer than requested. We override the dpr to 1 so the buffer
   *   is exactly targetW × targetH.
   *
   * WHY CSS size kept at clientWidth/Height: if we shrank the CSS to
   *   match the buffer (1920×1080), the canvas would explode to fill
   *   the whole screen during export — jarring. Keeping the CSS size
   *   stable means the user sees the same preview, just at a higher
   *   internal resolution being captured.
   */
  resizeTo(targetW: number, targetH: number): void {
    this.dpr = 1
    const cssW = this.canvas.clientWidth || targetW
    const cssH = this.canvas.clientHeight || targetH
    this.applySize(cssW, cssH, targetW, targetH)
  }

  /**
   * Apply a (cssW, cssH, bufW, bufH) size pair to the renderer + canvas
   * and propagate to scenes. Called by both resize() and resizeTo().
   *
   * WHY setPixelRatio(1): Three's WebGLRenderer has its own DPR
   *   handling, but we've already multiplied it in manually (scale =
   *   dpr * quality). Telling Three "1" makes it use our buffer
   *   dimensions as-is rather than re-scaling them.
   *
   * WHY setSize(bufW, bufH, false): the third arg `updateStyle=false`
   *   tells Three NOT to touch the canvas's CSS size — we set the CSS
   *   size ourselves on the next two lines.
   */
  private applySize(cssW: number, cssH: number, bufW: number, bufH: number): void {
    this.renderer.setPixelRatio(1) // we handle scale manually
    this.renderer.setSize(bufW, bufH, false)
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    // tell the active scene(s) about the new resolution
    for (const s of this.manager.getRenderingScenes()) {
      s.resize(bufW, bufH, this.dpr)
    }
  }

  /**
   * Switch to a scene by id. Delegates to SceneManager.switchTo (which
   * begins a crossfade). Immediately sizes the new scene so it doesn't
   * render at the default 1×1 for one frame.
   *
   * WHY re-resize after switchTo: the new scene was created lazily
   *   inside SceneManager and may not yet know the current buffer
   *   size. Without this it would render one frame at its default
   *   (probably 1×1 or whatever its init() set), causing a one-frame
   *   flash of garbage before the next resize.
   */
  setScene(id: 'liquid' | 'orbit' | 'tunnel' | 'grid' | 'particles'): void {
    this.manager.switchTo(id)
    // ensure the new scene gets sized immediately
    const w = this.renderer.domElement.width
    const h = this.renderer.domElement.height
    for (const s of this.manager.getRenderingScenes()) {
      s.resize(w, h, this.dpr)
    }
  }

  /**
   * Main render loop. `time` should be the audio playback position
   * (master clock, spec §26).
   *
   * ALGORITHM (Level 2) — the rAF render loop:
   *
   *   The loop is an arrow function stored on the instance so
   *   requestAnimationFrame can re-bind it without re-allocating. Each
   *   call:
   *
   *     1. Stop check: if `running` was flipped false (by stop()),
   *        return without scheduling another frame. This is the only
   *        way the loop ends.
   *
   *     2. Schedule the NEXT frame BEFORE doing work. If the work
   *        throws, rAF is still scheduled so the loop survives the
   *        exception (though the same throw will repeat next frame).
   *
   *     3. Compute dt. On the first frame (lastFrame=0), assume 1/60s
   *        to avoid a giant dt that would lurch scenes.
   *
   *     4. FPS measurement: accumulate dt and frame count; every 0.5s
   *        compute fps = frames / elapsed and reset. Then call
   *        tickAutoScaler() which may step quality up/down.
   *
   *     5. Master clock: read audio.getCurrentTime(). This is the time
   *        sent to scenes — NOT the wall-clock `now` from rAF.
   *
   *     6. Lazy analyser re-attach (see inline comment below for the
   *        full rationale). In short: the AudioEngine creates its
   *        AnalyserNode lazily after the first file is loaded; this
   *        engine may have started before that. We try to attach on
   *        every frame until it sticks.
   *
   *     7. analyzer.update(audioTime, duration) — produces the
   *        AudioFeatures for this frame. If null (not attached yet),
   *        bail out without rendering — there's nothing to drive
   *        the visuals.
   *
   *     8. mapper.map(features, settings) — produces the VisualState
   *        consumed by scenes.
   *
   *     9. manager.update(dt) — advances any in-flight transition
   *        (crossfade) by dt seconds. Updates opacity uniforms on
   *        both scenes.
   *
   *    10. autoScene.observe(...) — let the energy-based auto-switcher
   *        consider a scene change. Only when NOT transitioning (to
   *        avoid double-switches mid-crossfade).
   *
   *    11. Clear the canvas to settings.backgroundColor. Both scenes
   *        composite over this clear with NormalBlending.
   *
   *    12. For each scene the SceneManager reports as "rendering"
   *        (1 normally, 2 during a crossfade): call update(visualState,
   *        settings, audioTime) then render(renderer).
   *
   *    13. notifyStats() — push RenderStats to subscribers.
   *
   *   WHY use the audio time as master clock: see the file-level
   *   "MASTER CLOCK" section above. Short version: determinism for
   *   export, correctness on seek/pause.
   *
   *   WHY bail if `!features`: if the analyzer isn't attached, we
   *   have no audio data. We still scheduled the next rAF in step 2
   *   so the loop survives — when audio attaches, we'll start
   *   rendering on the very next frame.
   */
  private loop = (now: number) => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.loop)
    const dt = this.lastFrame ? (now - this.lastFrame) / 1000 : 1 / 60
    this.lastFrame = now

    // fps tracking
    this.fpsAcc += dt
    this.fpsCount++
    this.fpsTimer += dt
    if (this.fpsTimer >= 0.5) {
      this.fps = this.fpsCount / this.fpsAcc
      this.fpsAcc = 0
      this.fpsCount = 0
      this.fpsTimer = 0
      this.tickAutoScaler()
    }

    // master clock: use audio time if playing, else wall clock
    const audioTime = this.audio.getCurrentTime()
    const duration = this.audio.getDuration()
    // ============================================================
    // ALGORITHM (Level 2) — lazy analyser re-attach
    // ------------------------------------------------------------
    // The AudioEngine creates its AnalyserNode lazily: the user must
    // load a file AND the AudioContext must resume (which requires a
    // user gesture) before getAnalyser() returns a non-null node.
    //
    // This engine is constructed in a React useEffect on mount — which
    // can happen BEFORE the user has loaded a file. So init() may have
    // skipped the attach (an was null then).
    //
    // Rather than have the React layer remember to call attach() later
    // (error-prone — easy to forget, easy to call twice), we just try
    // on every frame. Once it succeeds, analyzer.isAttached() returns
    // true and we stop calling getAnalyser() — the branch short-
    // circuits. Cost: one boolean check per frame, negligible.
    //
    // WHY this is better than an event-based approach: events would
    //   require the AudioEngine to expose an "analyserReady" event,
    //   the VisualEngine to subscribe, and the React layer to wire it
    //   up. The lazy poll is two lines, no wiring, no unsubscribe
    //   cleanup, no race between event firing and subscription.
    // ============================================================
    // Lazily re-attach the analyser if the audio engine created it
    // after this VisualEngine started (e.g. when the user loads their
    // first file).
    if (!this.analyzer.isAttached()) {
      const an = this.audio.getAnalyser()
      if (an) this.analyzer.attach(an)
    }
    const features = this.analyzer.update(audioTime, duration)
    if (!features) return

    const settings = this.settingsRef
    if (!settings) return

    const visualState = this.mapper.map(features, settings)
    // WHY store latestFeatures: the debug overlay polls via
    //   getLatestFeatures() at its own rAF rate, decoupled from this
    //   engine's loop. Without this cache the overlay would either
    //   have to subscribe to onStats (which fires less often) or
    //   re-run the analyzer (waste).
    this.latestFeatures = features
    this.manager.update(dt)
    // Let the auto-scene controller observe features so it can decide
    // whether to trigger a transition. Only when there is no current
    // transition in flight to avoid double-switches.
    if (!this.manager.isTransitioning()) {
      this.autoScene.observe(audioTime, features.overallEnergy, features.beatPulse)
    }

    // Clear to the user's background color so crossfading scenes
    // composite cleanly over a known base. During a transition both
    // scenes are drawn with NormalBlending on top of this clear.
    this.renderer.setClearColor(settings.backgroundColor, 1)
    this.renderer.clear(true, true, false)

    // update both scenes during a transition
    for (const s of this.manager.getRenderingScenes()) {
      s.update(visualState, settings, audioTime)
      s.render(this.renderer)
    }
    // when only one scene is active, render it once (above handles that)

    this.notifyStats()
  }

  // WHY settingsRef is held separately from constructor args: settings
  //   change over time (the user moves a slider). Rather than have the
  //   React layer re-create the engine on every change, we expose
  //   setSettings() which updates the ref. The loop reads the ref each
  //   frame, so changes take effect on the next frame — no re-init.
  private settingsRef: UserSettings | null = null
  /** latest audio features — exposed for the debug overlay */
  // WHY `any` here: AudioFeatures includes typed arrays (Float32Array /
  //   Uint8Array) which the debug overlay reads but doesn't modify.
  //   Using `any` avoids a circular type dependency between the engine
  //   and the overlay module (which is in components/, not lib/).
  //   WARNING: callers must NOT mutate the returned arrays.
  private latestFeatures: any = null
  setSettings(s: UserSettings): void {
    this.settingsRef = s
    this.renderer.setClearColor(s.backgroundColor, 1)
  }

  /** Return the most recent AudioFeatures (for debug UI). */
  getLatestFeatures(): any {
    return this.latestFeatures
  }

  /**
   * Start the render loop. Idempotent — calling twice is a no-op
   * (the running guard prevents double-scheduling).
   *
   * WHY reset lastFrame=0: if the engine was stopped and restarted,
   *   lastFrame still holds the timestamp from before stop(). On
   *   restart, dt = (new_now - old_lastFrame) could be many seconds —
   *   a giant dt that would lurch the scene. Resetting to 0 makes the
   *   loop treat the next call as a "first frame" and assume 1/60s.
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.lastFrame = 0
    this.rafId = requestAnimationFrame(this.loop)
  }

  /**
   * Stop the render loop. Idempotent. Sets running=false so the next
   * loop callback returns early WITHOUT scheduling another frame.
   * cancelAnimationFrame is called defensively (the id may already
   * have fired; cancel is a no-op then).
   */
  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
  }

  /**
   * Subscribe to render stats (FPS, resolution, scene). Returns an
   * unsubscribe function — call it to stop receiving updates.
   *
   * WHY return a function (not require an unsubscribe method): React
   *   useEffect naturally handles function-returning subscriptions:
   *
   *     useEffect(() => engine.onStats(setStats), [])
   *
   *   The cleanup returned by useEffect is the unsubscribe function,
   *   which React calls on unmount. No need for the caller to remember
   *   a separate `off` method.
   */
  onStats(fn: (s: RenderStats) => void): () => void {
    this.statsListeners.add(fn)
    return () => this.statsListeners.delete(fn)
  }

  /**
   * Build a RenderStats snapshot and push it to every subscriber.
   * Called once per frame, after the render completes.
   *
   * WHY allocate a fresh object each frame: subscribers may hold the
   *   reference (e.g. setState in React). If we mutated a shared
   *   object, subscribers would see different values for the "same"
   *   stats object depending on when they read it. A fresh object
   *   makes snapshot semantics obvious.
   *
   *   The cost is one small object per frame — trivial next to the
   *   GL work. Not worth pooling.
   */
  private notifyStats(): void {
    const stats: RenderStats = {
      fps: this.fps,
      width: this.renderer.domElement.width,
      height: this.renderer.domElement.height,
      scene: this.manager.getActiveId(),
      transitioning: this.manager.isTransitioning(),
      transition: this.manager.getTransition(),
    }
    for (const l of this.statsListeners) l(stats)
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer
  }

  /**
   * Dispose all owned resources. Call on React unmount to avoid
   * leaking GPU memory. Stops the loop, disposes the SceneManager
   * (which disposes all scene geometries/materials/textures), and
   * disposes the WebGLRenderer (which loses the GL context).
   *
   * WHY no analyzer.dispose / mapper.dispose: those are pure JS
   *   objects with no native resources. GC handles them once the
   *   engine is unreachable.
   */
  dispose(): void {
    this.stop()
    this.manager.dispose()
    this.renderer.dispose()
  }
}
