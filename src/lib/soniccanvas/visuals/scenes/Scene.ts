import type * as THREE from 'three'
import type { UserSettings, VisualState } from '../../audio/types'

// ============================================================
// SYSTEM OVERVIEW — Scene Interface (Level 1)
// ------------------------------------------------------------
// WHAT: A `Scene` is the swappable visual unit of the SonicCanvas
//   renderer. The VisualEngine owns ONE active scene at a time
//   (plus an outgoing scene during crossfade transitions) and
//   drives it through a fixed lifecycle: init → (update → render)
//   per frame → dispose. Every concrete scene (Liquid, Orbit,
//   Tunnel, Grid, ParticleField) implements this interface.
//
// WHY AN INTERFACE (not a base class): scenes have wildly
//   different internals (fullscreen-shader-only scenes vs.
//   particle-system scenes vs. geometry scenes). A common base
//   class would force fields/methods that don't apply to all
//   shapes. The interface is the contract: "anything that can
//   draw one procedural layer per frame".
//
// WHAT GOES IN  : VisualState (normalized 0..1 audio-driven
//                 art knobs), UserSettings (user-facing sliders
//                 + colors), time (seconds, master clock from
//                 AudioEngine.currentTime), pixelRatio + viewport
//                 size on resize, opacity 0..1 on crossfade.
// WHAT GOES OUT  : rendered pixels into the WebGLRenderer's
//                 framebuffer. No return values; the renderer's
//                 canvas is mutated.
// WHAT DEPENDS ON IT: SceneManager (lifecycle + transitions),
//                 VisualEngine (per-frame update + render loop),
//                 AutoSceneController (indirectly — picks the
//                 next scene id, SceneManager calls init).
// WHAT IT DEPENDS ON: THREE.WebGLRenderer (passed in), the
//                 VisualState schema (audio/types.ts), the
//                 UserSettings schema (audio/types.ts).
//
// LIFECYCLE DIAGRAM:
//
//    ┌────────────────┐
//    │  switchTo(id)  │   SceneManager.switchTo
//    └───────┬────────┘
//            ▼
//    ┌────────────────┐
//    │  init(renderer)│  Build Three.js objects + ShaderMaterial
//    │                │  Allocate GPU buffers, set uniforms defaults
//    └───────┬────────┘
//            ▼
//    ┌────────────────────────────────────────────────┐
//    │  per frame (VisualEngine loop):                │
//    │                                                │
//    │   update(state, settings, time)                │  Push VisualState → uniforms
//    │       │                                        │  Push UserSettings → uniforms
//    │       ▼                                        │
//    │   setOpacity(o)   (only during crossfade)      │  Eased 0..1, ease-in-out cubic
//    │       │                                        │
//    │       ▼                                        │
//    │   render(renderer, time)                       │  Issue draw calls
//    └───────┬────────────────────────────────────────┘
//            ▼
//    ┌────────────────--┐
//    │ resize(w, h, dpr)│  Viewport changed — update u_resolution
//    └───────┬────────--┘  + camera aspect (if perspective camera)
//            ▼
//    ┌────────────────┐
//    │  dispose()     │  Free GPU memory: ShaderMaterial.dispose(),
//    │                │  geometry.dispose(), null out refs so GC can
//    │                │  collect the JS wrapper objects
//    └────────────────┘
//
// CROSSFADE CONTRACT (spec §17):
//   Each scene exposes a `u_opacity` uniform (0..1) and outputs
//   non-premultiplied alpha `vec4(col, u_opacity)`. The
//   SceneManager eases the opacity 0→1 on the incoming scene and
//   1→0 on the outgoing scene; VisualEngine clears the canvas to
//   UserSettings.backgroundColor before rendering both scenes so
//   NormalBlending composites correctly:
//      result_pixel = dst_pixel * (1 - alpha) + src_pixel * alpha
//   When `opacity === 1` the scene is fully opaque (alpha = 1) and
//   the blend reduces to `dst*0 + src*1 = src`, i.e. the scene
//   replaces the background — exactly the normal opaque case.
// ============================================================

/**
 * Scene
 *
 * A procedural visual scene. Each scene owns its own Three.js objects
 * and ShaderMaterial. It receives a VisualState + UserSettings each
 * frame and updates its uniforms.
 *
 * The VisualEngine manages the renderer, camera, fullscreen quad, and
 * render loop; scenes just plug into that pipeline.
 *
 * Opacity support: scenes expose `setOpacity()` to support smooth
 * crossfade transitions (spec §17). When `opacity < 1`, the scene's
 * fragment shader should produce pre-multiplied alpha output and rely
 * on NormalBlending so the outgoing/incoming scenes composite
 * correctly over the cleared background.
 */
export interface Scene {
  /** stable id matching SceneId */
  readonly id: string
  /** human-readable display name */
  readonly name: string
  /** short description for UI */
  readonly description: string
  /**
   * Build Three.js objects. Called once with the active renderer.
   *
   * Lifecycle: called by SceneManager.switchTo when this scene
   * becomes active (or pre-warmed during a transition). Allocates
   * GPU resources: ShaderMaterials, BufferGeometry, attributes,
   * fullscreen-quad mesh. Sets uniform defaults that update() will
   * overwrite each frame.
   *
   * MUST be cheap enough to call mid-frame during a transition
   * (typically <5ms for a fullscreen-shader scene). Long GPU stalls
   * here show up as a dropped frame at the crossfade boundary.
   */
  init(): void
  /**
   * Update uniforms for this frame.
   *
   * Lifecycle: called every frame BEFORE render(). Receives the
   * freshly-computed VisualState (from VisualMapper) and the current
   * UserSettings (from the Zustand store). Pushes them into the
   * ShaderMaterial's uniforms so the next draw call sees the new
   * values. No GL commands issued here — pure JS → uniform writes.
   *
   * `time` is the master clock in SECONDS, sourced from
   * AudioEngine.currentTime (not wall-clock performance.now()), so
   * visuals stay in sync with audio playback even if the RAF loop
   * drops frames.
   */
  update(state: VisualState, settings: UserSettings, time: number): void
  /**
   * Handle viewport resize.
   *
   * Lifecycle: called by VisualEngine when the canvas size or
   * pixelRatio changes (ResizeObserver + manual resizeTo for
   * exports). Scenes update their `u_resolution` uniform and, if
   * they use a PerspectiveCamera (OrbitScene, ParticleFieldScene),
   * update `camera.aspect` + `updateProjectionMatrix()`.
   *
   * WARNING: must update camera.aspect BEFORE
   * updateProjectionMatrix(); reversing the order produces a one-
   * frame stretched image.
   */
  resize(width: number, height: number, pixelRatio: number): void
  /**
   * Set the scene's compositing opacity (0..1) for crossfades.
   *
   * Lifecycle: called by SceneManager during transitions (eased
   * 0→1 on incoming, 1→0 on outgoing, ease-in-out cubic). Also
   * called once with `1` at init to restore full opacity after a
   * dispose/re-init cycle. Outside of transitions this method is
   * not called — the scene keeps its last-set opacity.
   *
   * The value is written to a `u_opacity` uniform and read by the
   * fragment shader's final `gl_FragColor.a` channel.
   */
  setOpacity(o: number): void
  /**
   * Render one frame.
   *
   * Lifecycle: called every frame AFTER update(). Issues the GL
   * draw call(s) for this scene's meshes/points. The renderer's
   * framebuffer is cleared by VisualEngine BEFORE calling render()
   * (so multiple scenes during a transition can composite on a
   * known base color).
   *
   * `time` is passed again (not stored) so the renderer is the
   * source of truth for the master clock — scenes never read wall
   * clock directly.
   */
  render(renderer: THREE.WebGLRenderer): void
  /**
   * Release GPU resources when this scene is being torn down.
   *
   * Lifecycle: called by SceneManager after the crossfade completes
   * (i.e. when the outgoing scene has eased to opacity 0). Frees
   * the ShaderMaterial (program), geometry (VBO), and nulls out
   * JS references so the garbage collector can reclaim the wrapper
   * objects. After dispose() the scene is unusable — calling
   * render() would no-op (the scene/camera refs are null).
   *
   * WARNING: forgetting to dispose a scene leaks GPU memory fast
   * (each scene = 1 shader program + several VBOs). The
   * SceneManager's mid-transition interrupt path disposes the
   * PREVIOUS outgoing scene to avoid holding three scenes at once.
   */
  dispose(): void
}
