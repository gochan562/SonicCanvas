import * as THREE from 'three'
import type { Scene } from './Scene'
import type { UserSettings, VisualState } from '../../audio/types'

/**
 * GridScene (spec §16 Scene 5 — GRID / GEOMETRIC)
 *
 * Visual concept:
 *   * procedural lines
 *   * grids
 *   * waves
 *   * rotating planes
 *   * geometric transformations
 *
 * Mappings:
 *   bass → wave amplitude
 *   beat → grid pulse
 *   mid → geometry rotation
 *   treble → line density
 *   energy → brightness
 *
 * Implemented as a fullscreen shader drawing an audio-reactive grid
 * plane (perspective) with wave displacement and rotating geometry.
 * Pure GLSL — no imported assets.
 */

const VERT = /* glsl */ `
  // ============================================================
  // VERTEX SHADER — fullscreen pass-through
  // ============================================================
  // COORDINATE SYSTEM: clip space (-1..1), no matrix needed
  // ============================================================
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  // ============================================================
  // FRAGMENT SHADER — Grid (audio-reactive perspective grid)
  // --------------------------------------------------------------
  // Pipeline (top to bottom):
  //   1. UNIFORMS         — audio + visual + color inputs
  //   2. NOISE PRIMITIVES — hash2 / vnoise (value noise only, no FBM)
  //   3. PERSPECTIVE PROJ — planeProject (uv → fake-3D world coords)
  //   4. GRID LINES       — gridLines (SDF grid via fwidth)
  //   5. main():
  //        COORDINATE SYSTEM       — uv + aspect correction
  //        ROLL                     — rotation driven by mid + beat
  //        WAVE DISPLACEMENT        — bass-driven wave + noise distortion
  //        LINE DENSITY             — treble + particle scaling
  //        DEPTH FADE               — distant grid lines fade
  //        BASE COLOR               — secondary (near) → primary (far)
  //        GRID LINE COLOR          — primary/secondary mix modulated by wave
  //        BEAT PULSE                — bright horizon flash
  //        HORIZON GLOW              — glow along the horizon line
  //        SKY TINT                  — gradient at top
  //        BRIGHTNESS / GLOW         — overall multipliers
  //        VIGNETTE                  — darken edges
  //        TONEMAP                   — soft clip bright areas
  //        CROSSFADE ALPHA           — non-premultiplied output
  // ============================================================
  precision highp float;

  varying vec2 vUv;

  // ============================================================
  // SECTION 1 — UNIFORMS
  // ============================================================
  // Same uniform set as TunnelScene (u_<name>, 0..1 unless noted).
  // --------------------------------------------------------------

  // SHADER UNIFORM: u_resolution
  // Purpose: drawing-buffer size; aspect correction
  // Safe to modify: YES (set via resize())
  uniform vec2  u_resolution;

  // SHADER UNIFORM: u_time
  // Purpose: master clock (seconds)
  // Safe to modify: YES
  uniform float u_time;

  // SHADER UNIFORM: u_bass
  // Purpose: low-frequency energy → wave amplitude (vertical grid displacement)
  // Normal range: 0..1
  // Increased: more violent wave displacement
  // Decreased: calmer, flatter grid
  // Safe to modify: YES
  uniform float u_bass;

  // SHADER UNIFORM: u_mid
  // Purpose: mid-frequency energy → grid rotation + secondary wave phase
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_mid;

  // SHADER UNIFORM: u_treble
  // Purpose: high-frequency energy → grid line density (more cells)
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_treble;

  // SHADER UNIFORM: u_energy
  // Purpose: overall energy → brightness
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_energy;

  // SHADER UNIFORM: u_beat
  // Purpose: short-lived beat pulse → grid roll + horizon flash
  // Normal range: 0..1 (decaying)
  // Safe to modify: YES
  uniform float u_beat;

  // SHADER UNIFORM: u_motion
  // Purpose: global motion speed multiplier (wave speed)
  // Normal range: 0..3
  // Safe to modify: YES
  uniform float u_motion;

  // SHADER UNIFORM: u_glow
  // Purpose: glow strength (grid line intensity + horizon glow)
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_glow;

  // SHADER UNIFORM: u_distortion
  // Purpose: noise-distortion amplitude for the wave field
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_distortion;

  // SHADER UNIFORM: u_colorShift
  // Purpose: signed (-1..1) hue offset (grid line color modulation)
  // Safe to modify: YES
  uniform float u_colorShift;

  // SHADER UNIFORM: u_intensity
  // Purpose: master brightness multiplier (final col *= u_intensity)
  // Normal range: 0..3
  // Safe to modify: YES
  uniform float u_intensity;

  // SHADER UNIFORM: u_particles
  // Purpose: particle-activity multiplier for grid line density
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_particles;

  // SHADER UNIFORM: u_primary
  // Purpose: primary grid color (far / top)
  // Safe to modify: YES
  uniform vec3  u_primary;

  // SHADER UNIFORM: u_secondary
  // Purpose: secondary grid color (near / bottom)
  // Safe to modify: YES
  uniform vec3  u_secondary;

  // SHADER UNIFORM: u_background
  // Purpose: background color (sky tint + base fill)
  // Safe to modify: YES
  uniform vec3  u_background;

  // SHADER UNIFORM: u_opacity
  // Purpose: crossfade alpha (0..1)
  // Safe to modify: YES
  uniform float u_opacity;

  // ============================================================
  // SECTION 2 — NOISE PRIMITIVES (shared pattern)
  // ============================================================
  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }
  float vnoise(vec2 p) {
    const float K1 = 0.366025404;
    const float K2 = 0.211324865;
    vec2 i = floor(p + dot(p, vec2(K1)));
    vec2 a = p - i + dot(i, vec2(K2));
    vec2 o = step(a.yx, a.xy) * vec2(1.0, 0.0);
    vec2 b = a - o + vec2(K2);
    vec2 c = a - 1.0 + 2.0 * vec2(K2);
    vec3 h = max(0.5 - vec3(dot(a,a), dot(b,b), dot(c,c)), 0.0);
    vec3 n = h * h * h * h * vec3(
      dot(a, hash2(i)),
      dot(b, hash2(i + o)),
      dot(c, hash2(i + 1.0))
    );
    return dot(n, vec3(70.0));
  }

  // ============================================================
  // SECTION 3 — PERSPECTIVE PROJECTION
  // --------------------------------------------------------------
  // Project a 2D plane to fake-3D by treating uv.y as depth.
  // Returns vec3(worldX, worldY, worldZ) so we can render a horizon
  // line grid in perspective.
  //
  // WHY this fake-3D (not real 3D mesh): no camera/mesh needed,
  //   runs entirely in the fragment shader, gives the classic
  //   "Tron grid receding to horizon" look. A real PlaneGeometry
  //   would require perspective camera + line mesh; this is cheaper.
  //
  // roll rotates the plane around X to tilt it forward (gives the
  // horizon some movement instead of being a flat line).
  // ============================================================
  // Project a 2D plane to fake-3D by treating uv.y as depth.
  // Returns vec3(worldX, worldY, worldZ) so we can render a horizon
  // line grid in perspective.
  vec2 planeProject(vec2 uv, float roll) {
    // y is depth: 0 (near) at bottom, 1 (far) at top
    float depth = uv.y;
    // perspective scale: things shrink with depth
    float scale = 1.0 / (1.0 + depth * 4.0);
    // x position centered & scaled by perspective
    float x = (uv.x - 0.5) * scale;
    // world Z is depth (we use it for the wave height)
    float z = depth * 8.0;
    // rotate around X (roll the plane forward) for a subtle tilt
    float t = roll;
    float ny = z * cos(t) - 0.0 * sin(t);
    return vec2(x, ny);
  }

  // ============================================================
  // SECTION 4 — GRID LINES (SDF via fwidth)
  // --------------------------------------------------------------
  // Draws a 2D grid of lines on the given uv-space, with thickness.
  // density controls how many cells per unit.
  //
  // WHY fwidth for thickness: fwidth gives the screen-space
  //   derivative, so the line thickness stays 1-2 pixels regardless
  //   of how far away the grid cell is. Without fwidth, distant
  //   grid lines would shimmer/alias as they shrink below 1 pixel.
  //   Standard anti-aliasing trick from the IQ "grid" article.
  // ============================================================
  // Draw a 2D grid of lines on the given uv-space, with thickness.
  // density controls how many cells per unit.
  float gridLines(vec2 uv, float density, float thickness) {
    vec2 g = abs(fract(uv * density - 0.5) - 0.5) / fwidth(uv * density);
    float line = min(g.x, g.y);
    return 1.0 - smoothstep(0.0, thickness, line);
  }

  // ============================================================
  // SECTION 5 — MAIN: grid composition pipeline
  // ============================================================
  void main() {
    // ============================================================
    // COORDINATE SYSTEM (uv + aspect)
    // --------------------------------------------------------------
    // NOTE: Unlike LiquidScene/TunnelScene, here we do NOT center uv
    //   at 0 — uv.y is used as a 0..1 depth value, so we keep it in
    //   that range. Only x gets aspect correction.
    // ============================================================
    vec2 uv = vUv;
    // adjust aspect so squares aren't stretched
    float aspect = u_resolution.x / u_resolution.y;
    vec2 puv = uv;
    puv.x *= aspect;

    // ============================================================
    // ROLL (rotation driven by mid + beat)
    // --------------------------------------------------------------
    // roll = base 0.2 + slow sin drift + mid + beat. Beat gives a
    //   brief "snap" rotation on each kick — the grid tilts forward
    //   momentarily then settles back.
    // ============================================================
    // rotation driven by mid + a slow drift; beat gives a snap
    float roll = 0.2 + sin(u_time * 0.2) * 0.1 + u_mid * 0.6 + u_beat * 0.25;
    vec2 world = planeProject(puv - vec2(0.5, 0.0), roll);

    // ============================================================
    // WAVE DISPLACEMENT (bass-driven + perpendicular wave + noise)
    // --------------------------------------------------------------
    // Primary wave: sin(world.y * 1.2 - time*(1.5+motion*1.5)) — moves
    //   forward over time, amplitude scales with bass + beat.
    // Secondary wave: sin(world.x * 2.0 + ...) — perpendicular
    //   component for richness (prevents parallel-only waves).
    // Noise distortion: vnoise adds organic turbulence via distortion.
    // ============================================================
    // wave displacement along the depth axis — bass drives amplitude
    float waveAmp = 0.3 + u_bass * 1.2 + u_beat * 0.5;
    float wave = sin(world.y * 1.2 - u_time * (1.5 + u_motion * 1.5)) * waveAmp;
    // secondary perpendicular wave for richness
    wave += sin(world.x * 2.0 + u_time * 0.7 + u_mid * 3.0) * waveAmp * 0.4;
    // distortion warps the grid via noise
    float n = vnoise(world * 0.6 + u_time * 0.05);
    wave += (n - 0.5) * (0.2 + u_distortion * 1.0);

    // ============================================================
    // DISPLACED GRID (apply wave as a Y offset to the grid uv)
    // ============================================================
    // displace the grid in world space
    vec2 dispUv = world + vec2(0.0, wave * 0.15);

    // ============================================================
    // LINE DENSITY (treble + particles add cells)
    // --------------------------------------------------------------
    // Base 6 cells, treble adds up to 8 more, particles add up to 4.
    // Higher density = finer grid mesh.
    // ============================================================
    // line density: treble adds more cells
    float density = 6.0 + u_treble * 8.0 + u_particles * 4.0;
    float grid = gridLines(dispUv, density, 1.5);

    // ============================================================
    // DEPTH FADE (lines fade at the very near and very far edges)
    // --------------------------------------------------------------
    // smoothstep(0, 0.05, depth) → 0 at depth=0 (very near, avoid
    //   the grid running off the bottom of the screen).
    // smoothstep(1, 0.6, depth) → 0 at depth=1 (very far, fade into
    //   the horizon).
    // ============================================================
    // depth fade: distant grid lines fade out
    float depth = puv.y;
    float fade = smoothstep(0.0, 0.05, depth) * smoothstep(1.0, 0.6, depth);

    // ============================================================
    // BASE COLOR (gradient + ambient fill)
    // --------------------------------------------------------------
    // base: gradient from secondary (near) → primary (far).
    // col: mix of background and dim base — gives a non-flat ground.
    // ============================================================
    // base color: gradient from secondary (near, bottom) → primary (far, top)
    vec3 base = mix(u_secondary, u_primary, smoothstep(0.0, 1.0, depth));
    // ambient background fill
    vec3 col = mix(u_background, base * 0.4, 0.6 + u_energy * 0.4);

    // ============================================================
    // GRID LINE COLOR (primary/secondary mix modulated by wave + shift)
    // --------------------------------------------------------------
    // sin(time + wave + colorShift*3) creates a traveling color
    //   modulation along the grid — colors sweep primary↔secondary
    //   across the surface over time.
    // ============================================================
    // apply grid lines
    vec3 gridCol = mix(u_primary, u_secondary, 0.5 + 0.5 * sin(u_time + wave + u_colorShift * 3.0));
    col = mix(col, gridCol, grid * fade * (0.7 + u_glow * 0.5));

    // ============================================================
    // BEAT PULSE (bright horizon flash)
    // --------------------------------------------------------------
    // On beat, the whole visible grid brightens briefly — synced
    //   visual kick on each beat pulse.
    // ============================================================
    // beat pulse: bright flash along the whole horizon
    col += gridCol * u_beat * 0.4 * fade;

    // ============================================================
    // HORIZON GLOW (bright line at depth = 0.5)
    // --------------------------------------------------------------
    // smoothstep(0.02, 0, |depth - 0.5|) creates a thin bright line
    //   at the mid-depth (the visual "horizon"). Glow + energy scale
    //   the intensity.
    // ============================================================
    // secondary horizon line glow
    float horizon = smoothstep(0.02, 0.0, abs(depth - 0.5));
    col += (u_primary + u_secondary) * 0.5 * horizon * (0.2 + u_glow * 0.6 + u_energy * 0.4);

    // ============================================================
    // SKY TINT (gradient at top, fades into background)
    // ============================================================
    // top sky tint — slight gradient instead of flat bg
    float sky = smoothstep(0.5, 1.0, depth);
    col = mix(col, u_background * 1.3, sky * 0.5);

    // ============================================================
    // BRIGHTNESS / GLOW (overall multipliers + intensity master)
    // ============================================================
    // brightness master
    col *= 0.5 + u_energy * 1.0 + u_glow * 0.3;
    col *= u_intensity;

    // ============================================================
    // VIGNETTE (darken edges to focus on center)
    // ============================================================
    // vignette
    vec2 vu2 = (uv - 0.5);
    vu2.x *= aspect;
    col *= 1.0 - 0.4 * smoothstep(0.5, 1.0, length(vu2));

    // ============================================================
    // TONEMAP (Reinhard-style soft clip, same as LiquidScene)
    // ============================================================
    // cheap tonemap
    col = col / (1.0 + col * 0.4);

    // ============================================================
    // CROSSFADE ALPHA (non-premultiplied for NormalBlending)
    // ============================================================
    // crossfade: non-premultiplied alpha
    gl_FragColor = vec4(col, u_opacity);
  }
`

function fullscreenQuadGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const verts = new Float32Array([
    -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0,
  ])
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1])
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  return geo
}

export class GridScene implements Scene {
  readonly id = 'grid'
  readonly name = 'Grid'
  readonly description =
    'Audio-reactive perspective grid with wave displacement and rotating geometry.'

  private material: THREE.ShaderMaterial | null = null
  private mesh: THREE.Mesh | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.OrthographicCamera | null = null

  /**
   * Build the fullscreen-quad Mesh + ShaderMaterial. Called once
   * when this scene becomes active. Same structure as LiquidScene +
   * TunnelScene (OrthographicCamera placeholder, NormalBlending for
   * crossfade compositing, fullscreen quad).
   */
  init(): void {
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_time: { value: 0 },
        u_bass: { value: 0 },
        u_mid: { value: 0 },
        u_treble: { value: 0 },
        u_energy: { value: 0 },
        u_beat: { value: 0 },
        u_motion: { value: 1 },
        u_glow: { value: 1 },
        u_distortion: { value: 0.5 },
        u_colorShift: { value: 0 },
        u_intensity: { value: 1 },
        u_particles: { value: 0.5 },
        u_primary: { value: new THREE.Color('#ff2d95') },
        u_secondary: { value: new THREE.Color('#2d9bff') },
        u_background: { value: new THREE.Color('#05030d') },
        u_opacity: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    })
    this.mesh = new THREE.Mesh(fullscreenQuadGeometry(), this.material)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  /**
   * Per-frame uniform push. Same VisualState → uniform renames as
   * LiquidScene (state.pulse → u_beat, state.glow → u_glow).
   */
  update(state: VisualState, settings: UserSettings, time: number): void {
    if (!this.material) return
    const u = this.material.uniforms
    u.u_time.value = time
    u.u_bass.value = state.bass
    u.u_mid.value = state.mid
    u.u_treble.value = state.treble
    u.u_energy.value = state.energy
    u.u_beat.value = state.pulse
    u.u_motion.value = settings.motion
    u.u_glow.value = state.glow
    u.u_distortion.value = state.distortion
    u.u_colorShift.value = state.colorShift
    u.u_intensity.value = settings.intensity
    u.u_particles.value = state.particles
    u.u_primary.value.copy(settings.primaryColor)
    u.u_secondary.value.copy(settings.secondaryColor)
    u.u_background.value.copy(settings.backgroundColor)
  }

  /**
   * Set crossfade opacity. Writes straight to u_opacity; the
   * fragment shader uses it as gl_FragColor.a.
   */
  setOpacity(o: number): void {
    if (this.material) this.material.uniforms.u_opacity.value = o
  }

  /**
   * Viewport resize. Updates u_resolution so aspect correction
   * stays right. (OrthographicCamera is never read by the vertex
   * shader, so no camera update is needed.)
   */
  resize(width: number, height: number): void {
    if (this.material) {
      this.material.uniforms.u_resolution.value.set(width, height)
    }
  }

  /**
   * Issue one draw call (the fullscreen quad). VisualEngine has
   * already cleared the framebuffer to backgroundColor before
   * calling this so crossfade compositing works.
   */
  render(renderer: THREE.WebGLRenderer): void {
    if (this.scene && this.camera) {
      renderer.render(this.scene, this.camera)
    }
  }

  /**
   * Free GPU resources. Disposes the ShaderMaterial program +
   * geometry VBO and nulls all 4 fields for GC. Called by
   * SceneManager after the crossfade-out completes.
   */
  dispose(): void {
    this.material?.dispose()
    this.mesh?.geometry.dispose()
    this.scene = null
    this.camera = null
    this.mesh = null
    this.material = null
  }
}
