import type { SceneId } from '../audio/types'
import type { VisualEngine } from '../visuals/VisualEngine'

/**
 * ============================================================================
 * MODULE: AutoSceneController — energy-based automatic scene rotation
 * ============================================================================
 *
 * WHAT IT IS
 *   A heuristic-only (no ML, no music-segmentation) automatic scene
 *   switcher. Each frame it receives the latest AudioFeatures from
 *   the VisualEngine and decides whether to trigger a scene change.
 *   When it decides to switch, it calls `visual.setScene(next)`,
 *   which triggers the SceneManager's crossfade.
 *
 * WHY IT EXISTS
 *   Spec §46 calls for "automatic scene changes based on musical
 *   energy". A user who picked the wrong scene for a track (e.g.
 *   Liquid for an aggressive EDM track) shouldn't have to babysit
 *   the scene picker the whole time. The controller keeps the
 *   visuals *moving* through the scene palette as the music changes,
 *   without requiring user attention.
 *
 *   The heuristic approach is a deliberate tradeoff vs. ML-based
 *   music segmentation: a 100-line state machine runs anywhere, has
 *   no model to load, and is debuggable by reading the code. ML
 *   segmentation would be more accurate but adds 10MB+ of model
 *   weight and a CPU/GPU budget we'd rather spend on visuals. The
 *   spec calls out that this is heuristic; an ML swap-in is a future
 *   enhancement point.
 *
 * WHAT GOES IN
 *   - setEnabled(b)        — toggle auto-switching on/off
 *   - setVisualEngine(v)  — inject the engine (circular dep breaker)
 *   - observe(time, energy, beatPulse) — called every frame by the
 *     VisualEngine. The controller decides whether to switch and
 *     if so calls visual.setScene(...).
 *
 * WHAT COMES OUT
 *   - getTimelineInfo()   — UI-facing status (time since last switch,
 *     time until next forced rotation, current/avg energy). Drives
 *     the auto-scene timeline indicator in the UI.
 *   - onSceneChanged callback — fired when the controller auto-
 *     switches, so the UI's scene indicator can sync.
 *
 * WHAT DEPENDS ON IT
 *   - VisualEngine.ts (constructs it, calls observe every frame)
 *   - The UI (calls setEnabled, reads getTimelineInfo, subscribes
 *     to onSceneChanged)
 *
 * WHAT IT DEPENDS ON
 *   - VisualEngine (injected post-construction to break a circular
 *     dependency — see setVisualEngine)
 *   - audio/types.ts (SceneId)
 *
 * THREE TRIGGER CONDITIONS (the heart of the algorithm)
 *
 *   The controller fires a scene rotation on ANY ONE of these three
 *   conditions, evaluated in order. The first match wins; later
 *   checks are skipped that frame.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ 1. MAX-SCENE-TIME (forced rotation)                              │
 *   │   If the time since the last switch exceeds maxSceneTime (25s), │
 *   │   force a rotation. Ensures the user always sees variety even   │
 *   │   on a track with a single dynamic level (drone, ambient).      │
 *   │   Fires REGARDLESS of energy — pure time-based.                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *                              ▼ (no match)
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ 2. DROP DETECTION (energy spike)                                │
 *   │   If beatPulse > 0.6 (a beat is firing NOW) AND                 │
 *   │      energy > avg * dropThreshold (louder than recent average)  │
 *   │      AND energy > 0.5 (absolute loudness, not just relative)     │
 *   │      AND sinceLast > minGap (don't fire too often)               │
 *   │   → switch scenes to "mark" the musical drop.                   │
 *   └──────────────────────────────────────────────────────────────────┘
 *                              ▼ (no match)
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ 3. QUIET SECTION (sustained low energy)                         │
 *   │   If the last 60 frames (~1s at 60fps) all had energy < 0.18    │
 *   │      AND history has at least 60 samples (need a real window)    │
 *   │      AND sinceLast > minGap                                       │
 *   │   → switch to "rotate away" from a busy scene into something     │
 *   │     that might suit the quieter section better.                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   WHY max-scene-time even on quiet tracks: without it, a 5-minute
 *     drone would stay on the same scene the whole time — boring.
 *     The forced rotation guarantees variety even when nothing
 *     musical is happening.
 *
 *   WHY drop detection requires beatPulse > 0.6 (not just energy
 *     spike): energy can spike on a sustained swell (a chorus coming
 *     in) without an actual beat. Requiring a concurrent beat pulse
 *     means we only fire on transient spikes — actual drops, not
 *     slow buildups.
 *
 *   WHY drop detection also requires energy > 0.5 absolute: a beat
 *     firing on top of a quiet section (the song's intro tom taps)
 *     would otherwise fire a "drop" rotation. The absolute floor
 *     filters those out.
 *
 *   WHY quiet-section check looks at the last 60 frames, not the
 *     whole window: we want *sustained* low energy, not a momentary
 *     dip. Requiring all 60 frames to be below the threshold means
 *     ~1 second of consistent quiet — long enough to be a section,
 *     not a gap.
 *
 *   WHY the order: time-based is checked first because it's the
 *     "override" — if we've been on this scene too long, switch
 *     regardless. Drop detection is second because drops are the
 *     most *musically meaningful* trigger (a marker the user wants
 *     to see). Quiet section is third because it's the *least*
 *     urgent trigger (no specific musical event to mark).
 *
 *   WHY scene rotation cycles through a fixed order (not random):
 *     random selection could pick the same scene twice in a row or
 *     jump between two scenes the user dislikes. A fixed cycle
 *     guarantees even coverage of the palette. The controller also
 *     re-aligns its index with whatever the engine reports as active,
 *     so a user-initiated manual switch doesn't desync the rotation.
 *
 * ============================================================================
 */

// The fixed rotation order through all 5 scenes. The controller
// advances sceneIndex through this array on each rotation.
//
// WHY this particular order: starts with 'liquid' (the most neutral,
// broadly-applicable scene) and progresses through the more
// energetic scenes. The order isn't musically tuned — it just
// ensures even coverage. Customization: reorder this array if you
// want a different rotation pattern.
const SCENE_ORDER: SceneId[] = ['liquid', 'orbit', 'tunnel', 'grid', 'particles']

export class AutoSceneController {
  // WHY `enabled` defaults to false: the auto-switcher is opt-in.
  //   The user enables it from the UI when they want it. Auto-enabling
  //   would surprise users who didn't ask for it (their scene keeps
  //   changing for no apparent reason).
  private enabled = false
  // WHY VisualEngine is injected post-construction (not in the
  //   constructor): the VisualEngine constructs the AutoSceneController
  //   in its own constructor. Passing `this` (the engine) into the
  //   AutoSceneController constructor would require `this` before
  //   super() returns, which JS disallows. The two-step setVisualEngine
  //   pattern breaks the cycle.
  private visual: VisualEngine | null = null
  /** Optional callback invoked whenever the controller auto-switches a scene. */
  // WHY the callback (not a typed event emitter): one consumer (the
  //   UI) needs to know about auto-switches. A callback is simpler
  //   than an event emitter (no unsubscribe, no Set to manage) for a
  //   single subscriber. If a second consumer appears, promote to a
  //   Set of listeners.
  onSceneChanged: ((id: SceneId) => void) | null = null

  // ============================================================
  // PARAMETER: energyHistory (rolling window of recent energy)
  // Purpose:   keeps the last ~3 seconds of energy values so the
  //            controller can compute an average ("what's 'normal'
  //            right now?") for drop detection. The "drop" trigger
  //            needs to know if the current energy is significantly
  //            above the recent average.
  // Safe range: 60 .. 600 samples (1s .. 10s at 60fps).
  // Typical:   180 — exactly 3 seconds at 60fps. Long enough to
  //            average out beat-to-beat jitter, short enough to
  //            track section changes within a few seconds.
  // Try:       60 for hyper-reactive drop detection (each beat is a
  //            candidate "drop"); 300 for very stable averages (only
  //            long-build drops fire).
  // WARNING:   the drop detector compares current energy to avg *
  //            dropThreshold. A longer history makes the avg lag
  //            behind section transitions, which can cause false
  //            "drops" right after a verse→chorus transition (the
  //            avg still reflects the verse's low energy).
  // CUSTOMIZATION: tie this to fps for sample-rate independence —
  //            currently fixed at 60fps assumption (see WARNING on
  //            minGap below for the same issue).
  // ============================================================
  // rolling energy history (last ~3 seconds at 60fps)
  private energyHistory: number[] = []
  private readonly historyLen = 180

  // Tracks the audio time of the last switch (audio master clock, not
  // wall-clock). Used by all three trigger conditions to enforce the
  // minGap cooldown.
  //
  // WHY -1 sentinel (not 0): audio time can legitimately be 0 (the
  //   very start of the track). Using -1 as "never switched" lets us
  //   distinguish "first switch ever" from "switched at time 0".
  private lastSwitchTime = -1

  // ============================================================
  // PARAMETER: minGap (minimum seconds between switches)
  // Purpose:   cooldown between any two auto-switches. Without it,
  //            a busy section would fire switch after switch (drop
  //            detection triggers, scene changes, drop detection
  //            triggers again on the new scene's first beat, ...).
  // Safe range: 2.0 .. 30.0 seconds.
  // Typical:   6.0 — long enough that the user can register the new
  //            scene before it changes again, short enough that
  //            rapid-fire drops in an EDM track all get marked.
  // Try:       2.0 for hyper-active switching (visual chaos, can
  //            look intentional for glitch aesthetics); 15.0 for
  //            lazy rotation that only fires on big structural changes.
  // WARNING:   the max-scene-time trigger (maxSceneTime=25) MUST be
  //            > minGap, otherwise the forced rotation would always
  //            be blocked by the minGap cooldown and never fire.
  //            (The current code does NOT apply minGap to the
  //            max-scene-time trigger, so this warning is moot —
  //            but worth knowing if you change that.)
  // ============================================================
  private readonly minGap = 6.0 // seconds between forced switches

  // ============================================================
  // PARAMETER: maxSceneTime (forced rotation timer)
  // Purpose:   max seconds the controller will stay on one scene
  //            before forcing a rotation, regardless of musical
  //            activity. The "if in doubt, switch" trigger.
  // Safe range: 10.0 .. 120.0 seconds.
  // Typical:   25.0 — about 6-12 bars at typical tempos. Long
  //            enough that the user gets to *see* each scene, short
  //            enough that a 3-minute track visits ~7 scenes.
  // Try:       15.0 for snappy variety; 60.0 for slow, deliberate
  //            rotations that feel like a director's cut.
  // WARNING:   the UI's getTimelineInfo reports timeUntilNext =
  //            maxSceneTime - sinceLast. If maxSceneTime < minGap
  //            and the user manually switched recently, the "time
  //            until next" can show a negative number that confuses
  //            users. Keep maxSceneTime >= minGap + 5s as a rule.
  // ============================================================
  private readonly maxSceneTime = 25.0 // seconds before a forced rotation

  // ============================================================
  // PARAMETER: dropThreshold (multiplier on avg energy for drop detection)
  // Purpose:   the trigger condition for "drop detection" is:
  //               energy > avg * dropThreshold
  //            where avg is the rolling average of energyHistory.
  //            A threshold of 1.6 means "current energy must be 60%
  //            above the recent average" — a real spike, not just
  //            the natural variation of a beat.
  // Safe range: 1.2 .. 3.0.
  // Typical:   1.6 — a noticeable spike without being so high that
  //            only the loudest drops fire. EDM kicks hit ~1.8-2.0×
  //            the verse energy on a real drop.
  // Try:       1.3 for sensitive drop detection (every chorus counts
  //            as a drop); 2.5 for only the most dramatic drops.
  // WARNING:   this is multiplied against the *rolling average*, so
  //            a long historyLen (slow-moving average) makes drops
  //            easier to detect (current energy > stale avg * 1.6).
  //            A short historyLen makes the avg track current energy
  //            closely, so few things exceed it by 1.6× — drops
  //            stop firing. Tune historyLen and dropThreshold together.
  // ============================================================
  private readonly dropThreshold = 1.6 // current > avg * threshold triggers a drop

  // The audio time of the most recent observe() call. Used by
  // getTimelineInfo to compute "time since last switch" without
  // needing a fresh observe() call.
  private lastTime = 0

  // Current index into SCENE_ORDER. The controller advances this on
  // every rotation. Re-aligned to whatever the engine reports as
  // active on each switch (see rotateScene).
  private sceneIndex = 0

  /**
   * Inject the VisualEngine. Required before observe() will do
   * anything. Called by VisualEngine's constructor immediately after
   * constructing the controller.
   *
   * WHY this exists: see the file-level note about the circular
   *   dependency between VisualEngine (constructs the controller)
   *   and AutoSceneController (calls back into the engine to switch
   *   scenes). The post-construction injection breaks the cycle.
   */
  setVisualEngine(v: VisualEngine): void {
    this.visual = v
  }

  /**
   * Enable / disable the controller. When enabling, resets the
   * energy history and lastSwitchTime so we don't fire false
   * triggers immediately based on stale state from before the user
   * enabled.
   *
   * WHY reset on enable: the controller may have been disabled for
   *   minutes during which the user manually switched scenes. The
   *   energy history is stale (from before they disabled), and
   *   lastSwitchTime is from a previous session. Resetting both
   *   gives a clean start — the controller will spend the first
   *   ~0.5s building a fresh energy baseline (the 30-frame guard
   *   below) before it can fire any trigger.
   */
  setEnabled(b: boolean): void {
    this.enabled = b
    if (b) {
      // reset history so we don't fire false triggers immediately
      this.energyHistory = []
      this.lastSwitchTime = -1
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Returns info about the current auto-scene state for the UI:
   *   - timeSinceLastSwitch: seconds since the last scene rotation
   *   - timeUntilNext: estimated seconds until the next forced rotation
   *   - maxSceneTime: the max-scene-time threshold
   *   - minGap: the minimum gap between switches
   *   - currentEnergy: the latest smoothed energy value
   *   - avgEnergy: the rolling average energy
   *
   * Returns null when the controller is disabled (no meaningful
   * state to report).
   *
   * WHY this is a snapshot read (not a subscription): the UI polls
   *   this on its own rAF rate (typically every animation frame the
   *   overlay is visible). A subscription model would force the
   *   controller to call back into React state on every change,
   *   which is more complex than a polling read.
   */
  getTimelineInfo(): {
    timeSinceLastSwitch: number
    timeUntilNext: number
    maxSceneTime: number
    minGap: number
    currentEnergy: number
    avgEnergy: number
  } | null {
    if (!this.enabled) return null
    const avg = this.energyHistory.length > 0
      ? this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length
      : 0
    const since = this.lastSwitchTime < 0
      ? 0
      : Math.max(0, this.lastTime - this.lastSwitchTime)
    return {
      timeSinceLastSwitch: since,
      timeUntilNext: Math.max(0, this.maxSceneTime - since),
      maxSceneTime: this.maxSceneTime,
      minGap: this.minGap,
      currentEnergy: this.energyHistory.length > 0
        ? this.energyHistory[this.energyHistory.length - 1]
        : 0,
      avgEnergy: avg,
    }
  }

  /**
   * Called every frame by the VisualEngine. Decides whether to switch
   * scenes. `time` is the master clock (audio playback position).
   * `energy` is the smoothed overall energy 0..1.
   *
   * ALGORITHM (Level 2) — three-trigger scene rotation:
   *
   *   See the file-level "THREE TRIGGER CONDITIONS" section for the
   *   full picture. Per-frame walkthrough:
   *
   *   Step 0 — bail if disabled or no engine
   *     Cheap exit when the user has the controller off.
   *
   *   Step 1 — update energy history
   *     Push the latest energy value; shift the oldest out if we
   *     exceed historyLen. This is the rolling window the drop
   *     detector uses.
   *
   *   Step 2 — baseline guard
   *     If we have fewer than 30 samples (~0.5s at 60fps), bail. We
   *     need a real baseline before any trigger can fire — otherwise
   *     the first beat of the track would fire a "drop" (the avg is
   *     0, current is non-zero, current > 0 * 1.6 = 0, true).
   *
   *   Step 3 — compute the rolling average
   *     Plain arithmetic mean of the energy history. Used by the
   *     drop detector's "current > avg * threshold" check.
   *
   *   Step 4 — TRIGGER 1: max-scene-time
   *     If sinceLast >= maxSceneTime, rotate. This is the unconditional
   *     "if in doubt, switch" — fires regardless of energy state.
   *     No minGap check here (the max-scene-time IS the gap).
   *
   *   Step 5 — TRIGGER 2: drop detection
   *     If all four conditions hold:
   *       beatPulse > 0.6        — a beat is firing right now
   *       energy > avg * 1.6    — current is significantly above recent average
   *       energy > 0.5         — absolute loudness (not just relative)
   *       sinceLast > minGap    — cooldown has expired
   *     then rotate. The four-way AND prevents false triggers from
   *     quiet beats, sustained swells, or rapid-fire double drops.
   *
   *   Step 6 — TRIGGER 3: quiet section
   *     If we have ≥60 samples in history AND the last 60 all had
   *     energy < 0.18 AND sinceLast > minGap, rotate. This is the
   *     "the music went quiet, switch to a calmer scene" trigger.
   *
   *   WHY early-return on first match: only one trigger can fire
   *     per frame. If two fired (e.g. drop AND max-scene-time), we'd
   *     call visual.setScene twice, which would queue two transitions
   *     on top of each other (the second call's mid-transition
   *     handling would dispose the scene the first call just started
   *     fading in — visual chaos).
   *
   *   WARNING: this method assumes 60fps. The energy history is in
   *     *frames*, not seconds — at 120fps the 180-frame history
   *     covers only 1.5s instead of 3s; at 30fps it covers 6s.
   *     The dropThreshold's effectiveness changes with the sample
   *     rate. Fixing this properly requires either tracking dt
   *     and using a sliding time-window, or normalizing historyLen
   *     against measured fps.
   */
  observe(time: number, energy: number, beatPulse: number): void {
    if (!this.enabled || !this.visual) return
    // update history
    this.energyHistory.push(energy)
    if (this.energyHistory.length > this.historyLen) this.energyHistory.shift()
    // WHY 30 samples (not 60): we want the controller to be ready to
    //   fire as soon as we have a "decent" baseline, not the full
    //   history window. 30 ≈ 0.5s — enough to compute a non-trivial
    //   average, short enough that the controller activates within
    //   half a second of being enabled.
    if (this.energyHistory.length < 30) return // need a baseline

    const avg =
      this.energyHistory.reduce((a, b) => a + b, 0) /
      this.energyHistory.length
    const now = time

    // TRIGGER 1: forced rotation (max-scene-time)
    // No minGap check — max-scene-time IS the cooldown.
    const sinceLast = this.lastSwitchTime < 0 ? now : now - this.lastSwitchTime
    if (sinceLast >= this.maxSceneTime) {
      this.rotateScene(now)
      return
    }
    // TRIGGER 2: drop detection (energy spike on a beat)
    // The four-way AND: see file-level "DROP DETECTION" notes.
    if (
      beatPulse > 0.6 &&
      energy > avg * this.dropThreshold &&
      energy > 0.5 &&
      sinceLast > this.minGap
    ) {
      this.rotateScene(now)
      return
    }
    // TRIGGER 3: quiet section (sustained low energy)
    // WHY 60 samples (1s at 60fps): we want a sustained quiet, not
    //   a momentary dip. All 60 must be below 0.18 — a single loud
    //   frame in the window resets the check.
    if (
      this.energyHistory.length >= 60 &&
      this.energyHistory.slice(-60).every((e) => e < 0.18) &&
      sinceLast > this.minGap
    ) {
      this.rotateScene(now)
      return
    }
  }

  /**
   * Advance sceneIndex by one in SCENE_ORDER, re-align with whatever
   * the engine reports as the active scene (in case the user manually
   * switched), and trigger the crossfade via visual.setScene.
   *
   * WHY re-align before advancing: if the user manually switched
   *   scenes (via the UI) while the controller was running, our
   *   sceneIndex is now stale — it points at the *previous* rotation
   *   target, not what's currently active. Without re-alignment,
   *   we'd rotate to "next after the old target" — which could be
   *   the scene the user just switched away from (one step backward).
   *   Re-aligning to the active scene first means we always advance
   *   *forward* from wherever the user is.
   *
   *   Concretely: if the user manually picks 'orbit' (sceneIndex=1
   *   in SCENE_ORDER), our index was 0 from the last rotation. We
   *   re-align to 1, then advance to 2 ('tunnel') — correct. Without
   *   re-alignment we'd advance 0 → 1 ('orbit'), re-selecting what
   *   the user just picked.
   *
   *   If the engine reports no active scene (returns null), we skip
   *   the re-align and just advance the existing index.
   *
   * WHY call visual.setScene (not the SceneManager directly): the
   *   VisualEngine's setScene method also resizes the new scene to
   *   the current buffer dimensions — bypassing it would leave the
   *   new scene at its default size, causing a one-frame garbage
   *   flash before the next resize.
   *
   * WHY update lastSwitchTime after the switch (not before): if
   *   setScene throws (e.g. unknown scene id), we don't want to
   *   record a switch that didn't happen — the next observe() call
   *   would have a stale lastSwitchTime and skip triggers based on
   *   the failed switch.
   */
  private rotateScene(time: number): void {
    if (!this.visual) return
    this.sceneIndex = (this.sceneIndex + 1) % SCENE_ORDER.length
    const next = SCENE_ORDER[this.sceneIndex]
    // align our index with whatever the engine reports as active, so
    // we don't re-trigger immediately if the user manually switched.
    const active = this.visual.getManager().getActiveId()
    if (active) {
      const idx = SCENE_ORDER.indexOf(active)
      if (idx >= 0) this.sceneIndex = idx
      this.sceneIndex = (this.sceneIndex + 1) % SCENE_ORDER.length
    }
    const target = SCENE_ORDER[this.sceneIndex]
    this.visual.setScene(target)
    this.lastSwitchTime = time
    // Fire the callback after the switch is queued (not after the
    // transition completes — the UI's scene indicator should update
    // immediately to show "switching to X", not wait 0.6s).
    this.onSceneChanged?.(target)
  }
}
