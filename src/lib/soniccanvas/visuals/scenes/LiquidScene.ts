import * as THREE from 'three'
import type { Scene } from './Scene'
import type { UserSettings, VisualState } from '../../audio/types'

/**
 * LiquidScene — fullscreen procedural plasma shader.
 *
 * Spec §16 Scene 3 — LIQUID / PLASMA:
 *   * fullscreen shader
 *   * flowing procedural noise
 *   * fluid-like distortion
 *   * glowing color fields
 *   * warped geometry
 *
 * Mappings:
 *   bass → displacement strength
 *   mid → flow speed
 *   treble → fine detail
 *   energy → contrast
 *   spectrum → color
 *   beat → shockwave
 *
 * All visual content is generated in GLSL — no imported textures,
 * no 3D models. The vertex shader passes a fullscreen quad; the
 * fragment shader does all the work using FBM noise, domain warping,
 * and a cosine palette.
 */

/**
 * VERTEX SHADER — fullscreen quad pass-through.
 *
 * The mesh geometry already ships positions in clip space
 * (-1..1) so we don't need any matrix math here. The vertex
 * shader only forwards the built-in `uv` attribute (0..1)
 * down to the fragment shader as `vUv`.
 *
 * WHY a fullscreen quad (not three's built-in PlaneGeometry):
 *   clip-space vertices are constant — the renderer skips the
 *   projection matrix multiply entirely. Cheaper and means the
 *   shader runs identically at every aspect ratio.
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
  // FRAGMENT SHADER — Liquid Plasma
  // --------------------------------------------------------------
  // Procedural fullscreen plasma. Pipeline (top to bottom):
  //   1. UNIFORMS         — audio + visual + color inputs
  //   2. NOISE PRIMITIVES — hash2 / vnoise / fbm (value noise FBM)
  //   3. COLOR PALETTE   — cosine palette helper (Inigo Quilez)
  //   4. main():
  //        COORDINATE SYSTEM   — center uv + aspect correction
  //        FLOW SPEED          — master clock scaled by motion + mid
  //        DOMAIN WARPING      — two-pass FBM distortion (the "fluid")
  //        BASE FIELD          — fbm of warped coords
  //        FINE DETAIL         — high-frequency octave scaled by treble
  //        BEAT SHOCKWAVE      — expanding ring on beat pulse
  //        COLOR               — primary/secondary mix + cosine palette
  //        GLOW / POST         — brightness, glow halo, vignette, tonemap
  //        CROSSFADE ALPHA    — non-premultiplied output for NormalBlending
  // ============================================================

  precision highp float;

  varying vec2 vUv;

  // ============================================================
  // SECTION 1 — UNIFORMS
  // ============================================================
  // Convention: every uniform is 'u_<name>'. All scalars are 0..1
  // unless noted. VisualState + UserSettings from the TS side are
  // pushed in once per frame via update().
  // --------------------------------------------------------------

  // SHADER UNIFORM: u_resolution
  // Purpose: drawing-buffer size in pixels; used for aspect correction
  // Normal range: (1..7680, 1..4320) — capped by GPU max texture size
  // Increased: wider horizontal extent of the plasma field
  // Decreased: narrower field (squashed on wide screens if not corrected)
  // Safe to modify: YES (set via resize())
  uniform vec2  u_resolution;

  // SHADER UNIFORM: u_time
  // Purpose: master clock (seconds) from AudioEngine.currentTime — drives
  //          all procedural motion; ensures visuals stay synced with audio
  // Normal range: 0..track duration (typically 0..600)
  // Increased: faster plasma flow (proportional — not looped)
  // Decreased: slower flow (0 = frozen frame, useful for thumbnails)
  // Safe to modify: YES
  uniform float u_time;

  // ---------- audio features (all 0..1 unless noted) ----------
  // These come from VisualState; the VisualMapper has already applied
  // the user's *Reaction sliders + MappingCurves shaping.

  // SHADER UNIFORM: u_bass
  // Purpose: low-frequency energy → domain-warp amplitude (bigger distortions)
  // Normal range: 0..1
  // Increased: larger flowing distortions, more violent plasma motion
  // Decreased: calmer, smaller-scale ripples
  // Safe to modify: YES
  uniform float u_bass;

  // SHADER UNIFORM: u_mid
  // Purpose: mid-frequency energy → flow speed multiplier
  // Normal range: 0..1
  // Increased: faster plasma drift
  // Decreased: slower drift (more "viscous" feel)
  // Safe to modify: YES
  uniform float u_mid;

  // SHADER UNIFORM: u_treble
  // Purpose: high-frequency energy → fine-detail octave amplitude
  // Normal range: 0..1
  // Increased: more high-frequency shimmer / fine-grain texture
  // Decreased: smoother, lower-frequency plasma only
  // Safe to modify: YES
  uniform float u_treble;

  // SHADER UNIFORM: u_energy
  // Purpose: overall energy → brightness lift + palette phase offset
  // Normal range: 0..1
  // Increased: brighter, more saturated colors
  // Decreased: dimmer, more background-tinted
  // Safe to modify: YES
  uniform float u_energy;

  // SHADER UNIFORM: u_beat
  // Purpose: short-lived beat impulse (decays to 0); triggers shockwave
  // Normal range: 0..1 (decaying pulse — peak on kick, fades ~0.12s)
  // Increased: stronger / larger expanding shockwave ring
  // Decreased: no shockwave (0 = no ring drawn)
  // Safe to modify: YES
  uniform float u_beat;       // 0..1 decaying pulse

  // ---------- mapped visual state (UserSettings → VisualState) ----------

  // SHADER UNIFORM: u_intensity
  // Purpose: master brightness multiplier (final col *= u_intensity)
  // Normal range: 0..3 (UI slider, default 1)
  // Increased: brighter overall (clipped by tonemap at the end)
  // Decreased: dimmer; 0 = pure black
  // Safe to modify: YES
  uniform float u_intensity;

  // SHADER UNIFORM: u_motion
  // Purpose: global motion speed multiplier (flow speed + flow drift)
  // Normal range: 0..3 (UI slider, default 1)
  // Increased: faster plasma animation
  // Decreased: slower; 0 = static (only bass/beat impulses move)
  // Safe to modify: YES
  uniform float u_motion;

  // SHADER UNIFORM: u_glow
  // Purpose: glow / bloom strength — adds a center-weighted halo + brightness
  // Normal range: 0..2 (UI slider, default 1)
  // Increased: brighter, more "bloomy" look
  // Decreased: flatter, dimmer appearance
  // Safe to modify: YES
  uniform float u_glow;

  // SHADER UNIFORM: u_distortion
  // Purpose: domain-warp amplitude base — adds turbulence to the FBM warps
  // Normal range: 0..2 (UI slider, default 0.5)
  // Increased: more violent plasma distortion
  // Decreased: smoother, more laminar flow
  // Safe to modify: YES
  uniform float u_distortion;

  // SHADER UNIFORM: u_colorShift
  // Purpose: signed hue / palette phase offset (-1 cool/blue, +1 warm/red)
  // Normal range: -1..1 (UI slider, default 0)
  // Increased: warmer palette + phase-rotated cosine palette
  // Decreased: cooler palette
  // Safe to modify: YES
  uniform float u_colorShift; // -1..1

  // ---------- colors (THREE.Color RGB 0..1 each) ----------

  // SHADER UNIFORM: u_primary
  // Purpose: primary foreground color — mixes into the field at mid-range
  // Normal range: any RGB (typically magenta/pink tones)
  // Increased: brighter primary tint in the field
  // Decreased: more secondary/background showing through
  // Safe to modify: YES
  uniform vec3  u_primary;

  // SHADER UNIFORM: u_secondary
  // Purpose: secondary accent color — replaces primary at high field values
  // Normal range: any RGB (typically blue tones)
  // Increased: brighter secondary tint on field crests
  // Decreased: less color variation across the field
  // Safe to modify: YES
  uniform vec3  u_secondary;

  // SHADER UNIFORM: u_background
  // Purpose: background color — fills the field at low values (dark areas)
  // Normal range: any RGB (typically near-black)
  // Increased: less contrast against primary/secondary
  // Decreased: deeper darks, more punchy color contrast
  // Safe to modify: YES
  uniform vec3  u_background;

  // SHADER UNIFORM: u_particles
  // Purpose: particle-activity multiplier for the fine-detail octave amplitude
  // Normal range: 0..1 (UI particleAmount slider, default 0.5)
  // Increased: more fine shimmer (adds to u_treble for the detail layer)
  // Decreased: less fine-grain texture
  // Safe to modify: YES
  uniform float u_particles;

  // SHADER UNIFORM: u_opacity
  // Purpose: crossfade alpha (0..1) — eased by SceneManager during transitions
  // Normal range: 0..1 (1 when not transitioning)
  // Increased: more opaque (1 = fully visible)
  // Decreased: more transparent (0 = invisible; for crossfade-out only)
  // Safe to modify: YES (driven by setOpacity())
  uniform float u_opacity;

  // ============================================================
  // SECTION 2 — NOISE PRIMITIVES
  // --------------------------------------------------------------
  // WHY duplicated across scene files (LiquidScene, OrbitScene,
  //   TunnelScene, GridScene all define their own hash2/vnoise/fbm):
  //   GLSL has no #include / module system in WebGL1. Sharing a
  //   string via template literal concatenation is fragile (one
  //   typo breaks 4 shaders at once). Duplicating ~30 lines per
  //   file is cheaper to maintain than a custom shader preprocessor.
  // ============================================================

  // --- hash / value noise (cheap) -------------------------------------
  // Standard hash-noise. Safe to tune the lattice constants but keep
  // them in the [0,1) range so we don't accidentally pick up grid
  // artifacts.
  // WHY these specific magic numbers (127.1, 311.7, 269.5, 183.3,
  //   43758.5453123): the dot products produce well-distributed
  //   pseudo-random gradients; sin + fract is a cheap hash. These
  //   are widely-used IQ constants — changing them is cosmetic only,
  //   but high-frequency lattice artifacts can reappear. Avoid.
  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  // Simplex-style value noise (2D). Output range ~[-1, 1].
  // K1 = (sqrt(3)-1)/2, K2 = (3-sqrt(3))/6 — skew constants so the
  // triangular lattice is uniform. See Stefan Gustavson's simplex
  // noise paper for the math; here we just trust the constants.
  float vnoise(vec2 p) {
    const float K1 = 0.366025404; // (sqrt(3)-1)/2
    const float K2 = 0.211324865; // (3-sqrt(3))/6
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

  // Fractional Brownian Motion — sums several octaves of value noise
  // to produce organic-looking flow fields. 4-5 octaves is a good
  // balance between detail and performance on integrated GPUs.
  //
  // FBM = noise(p) + 0.5*noise(2p) + 0.25*noise(4p) + ...
  //   each octave: double frequency, halve amplitude → fractal self-
  //   similarity. The mat2 rotation prevents axis-aligned grid bias
  //   that arises from evaluating noise on a regular lattice.
  //
  // CUSTOMIZATION: 5 octaves is good for full-HD. Drop to 3 for low-end
  //   GPUs / exports. Add to 6-7 for ultra-detailed stills.
  // WARNING: each octave re-evaluates vnoise (≈ 3 hash calls). On weak
  //   GPUs, 5 octaves * 4 fbm calls (q.x, q.y, r.x, r.y, f) per pixel
  //   = ~60 hash calls/pixel. Profile before adding octaves.
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6); // rotation to avoid axis bias
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = m * p * 2.02;
      a *= 0.5;
    }
    return v;
  }

  // ============================================================
  // SECTION 3 — COLOR PALETTE (cosine palette)
  // --------------------------------------------------------------
  // Inigo Quilez's cosine palette: a + b * cos(2π(c*t + d))
  //   a = DC offset (mid-brightness)
  //   b = amplitude (color swing)
  //   c = frequency (number of color cycles across t)
  //   d = phase (color stops along t)
  // Gives smooth, continuous color gradients — no LUT, no texture.
  // WHY this over HSV: cosine palettes are coherent in RGB space
  //   (no hard discontinuities at hue=0/1) and GPU-cheap (3 cosines).
  // ============================================================
  // Cosine palette (Inigo Quilez style) — gives smooth, coherent color
  // gradients instead of random RGB every frame (spec §42).
  vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
    return a + b * cos(6.28318 * (c * t + d));
  }

  // ============================================================
  // SECTION 4 — MAIN: plasma pipeline
  // ============================================================
  void main() {
    // ============================================================
    // COORDINATE SYSTEM
    // --------------------------------------------------------------
    // vUv is 0..1 across the fullscreen quad. We center it (-0.5..0.5)
    // and correct the X axis by the aspect ratio so circular features
    // stay circular on wide screens (no horizontal squash on 16:9).
    // ============================================================
    vec2 uv = (vUv - 0.5);
    // correct aspect so circles don't squash on wide screens
    uv.x *= u_resolution.x / u_resolution.y;

    // ============================================================
    // FLOW SPEED (master time multiplier)
    // --------------------------------------------------------------
    // Time progresses faster with: higher u_motion (user slider),
    // higher u_mid (audio mid-band). The 0.15 baseline ensures the
    // scene never completely freezes even at motion=0 + silent input.
    // ============================================================
    // flow speed: driven by mid + base motion
    float t = u_time * (0.15 + u_motion * 0.4 + u_mid * 0.6);

    // ============================================================
    // DOMAIN WARPING (the "fluid" look)
    // --------------------------------------------------------------
    // Domain warping = use noise to OFFSET the input coordinates of
    // ANOTHER noise call. Two passes (q, then r) compound the warp
    // for richer swirling. This is the classic IQ "warp" pattern:
    //   https://iquilezles.org/articles/warp/
    //
    // bass + distortion scale the warp amplitude → bigger flowing
    // distortions on heavy bass / high distortion slider.
    // ============================================================
    // domain-warp coordinates (the "fluid" look). Bass increases the
    // warp amplitude → larger flowing distortions.
    float warpAmp = 1.2 + u_distortion * 1.5 + u_bass * 2.5;
    vec2 q = vec2(
      fbm(uv * 1.5 + vec2(0.0, t)),
      fbm(uv * 1.5 + vec2(5.2, 1.3) + vec2(t, 0.0))
    );
    vec2 r = vec2(
      fbm(uv + warpAmp * q + vec2(1.7, 9.2) + 0.15 * t),
      fbm(uv + warpAmp * q + vec2(8.3, 2.8) + 0.126 * t)
    );

    // ============================================================
    // BASE FIELD
    // --------------------------------------------------------------
    // Final FBM pass: sample noise at the twice-warped coords.
    // 'f' is the plasma density value that drives everything downstream
    // (color, brightness, detail).
    // ============================================================
    // base field — fbm of warped coords
    float f = fbm(uv + warpAmp * r);

    // ============================================================
    // FINE DETAIL (high-frequency octave)
    // --------------------------------------------------------------
    // Scales with treble + particles for sparkle on high frequencies.
    // Multiplied by 0.5 + 0.6 + 0.4 — those are NOT percentages of f,
    // they're weights blended into the detail amplitude. '(detail-0.5)'
    // re-centers vnoise from -0.5..0.5 so we don't bias f upward.
    // ============================================================
    // fine detail layer scaled by treble / particle activity
    float detail = fbm(uv * 5.0 + r * 2.0 + t * 0.5);
    f += (detail - 0.5) * (0.15 + u_treble * 0.6 + u_particles * 0.4);

    // ============================================================
    // BEAT SHOCKWAVE
    // --------------------------------------------------------------
    // Expanding ring from screen center, drawn when u_beat > 0.
    // As u_beat decays (1→0) the ring radius grows (1-beat grows),
    // so the ring expands OUTWARD over the beat's lifespan (~0.12s).
    // smoothstep(thick, 0, |dist - radius|) creates a soft-edged ring
    // of width ~2*thickness centered on 'radius'.
    //
    // WHY 'if (u_beat > 0.001)': skips the expensive smoothstep when
    //   no beat is active — most frames this branch is skipped.
    // WARNING: any tiny residual beat value (>0.001) will draw a faint
    //   ring at the screen edge (radius ≈ 1.45) — keep the threshold
    //   above 0.0005 to avoid stray rings.
    // ============================================================
    // shockwave on beat: a ring expanding from the center.
    float dist = length(uv);
    float shock = 0.0;
    if (u_beat > 0.001) {
      // expanding radius proportional to 1-beat (beat decays)
      float radius = (1.0 - u_beat) * 1.4 + 0.05;
      float thickness = 0.06;
      shock = smoothstep(thickness, 0.0, abs(dist - radius)) * u_beat;
    }

    // ============================================================
    // COLOR
    // --------------------------------------------------------------
    // Two-step process:
    //   1. Smoothstep gradient: background → primary (mid values) →
    //      secondary (high values), keyed on 'cf' = normalized field +
    //      colorShift offset. Gives broad color regions.
    //   2. Cosine palette overlay: blended 35% on top for fine-grain
    //      hue variation. The palette phase is swept by energy +
    //      colorShift so the user can "scrub" the whole spectrum.
    // ============================================================
    // color: combine primary/secondary along the field, then add an
    // energy-driven brightness lift. Color shift rotates the palette
    // phase so the user can sweep the whole spectrum.
    float cf = f * 0.5 + 0.5 + u_colorShift * 0.5;
    vec3 base = mix(u_background, u_primary, smoothstep(0.2, 0.85, cf));
    base = mix(base, u_secondary, smoothstep(0.55, 1.0, cf));
    // extra palette modulation for richness
    vec3 pal = palette(
      cf + u_energy * 0.4 + u_colorShift * 0.25,
      vec3(0.5),
      vec3(0.5),
      vec3(1.0),
      vec3(0.0, 0.33, 0.67)
    );
    vec3 col = mix(base, pal, 0.35);

    // ============================================================
    // GLOW / POST-PROCESSING
    // --------------------------------------------------------------
    // Three additive layers:
    //   - energy-driven brightness (col *= 0.5 + 1.2*energy)
    //   - glow multiplier + a center-weighted halo (1-dist term)
    //   - the beat shockwave ring color (primary+secondary blend)
    // Then a vignette darkens edges so the eye focuses on the center.
    // The final Reinhard-style tonemap 'col / (1 + col*0.4)' soft-
    // clips bright areas into a bloom-like rolloff instead of hard
    // clamping at 1.0 (which would create harsh white bands).
    // ============================================================
    // brightness + glow
    col *= 0.5 + u_energy * 1.2;
    col *= 0.6 + u_glow * 0.9;
    col += u_glow * 0.25 * (1.0 - dist);

    // beat shockwave adds a bright ring
    col += shock * (u_primary + u_secondary) * 1.5;

    // intensity master multiplier
    col *= u_intensity;

    // subtle vignette to focus the eye on the center
    float vig = smoothstep(1.5, 0.4, dist * 1.2);
    col *= 0.7 + 0.3 * vig;

    // cheap tonemap-ish clamp so bright areas bloom
    col = col / (1.0 + col * 0.4);

    // ============================================================
    // CROSSFADE ALPHA (output)
    // --------------------------------------------------------------
    // Output is NON-premultiplied: 'vec4(col, u_opacity)'.
    // WHY non-premultiplied with NormalBlending: NormalBlending in
    //   three.js uses blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA),
    //   giving 'result = dst*(1-a) + col*a'. For this to work, col
    //   must NOT already have alpha baked in (i.e. must be straight,
    //   not premultiplied). If we used premultiplied output we'd
    //   need CustomBlending with ONE/ONE_MINUS_SRC_ALPHA — same
    //   result but more setup. Non-premultiplied is the path of
    //   least resistance and matches what VisualEngine clears to.
    // ============================================================
    // crossfade: output non-premultiplied alpha so NormalBlending
    // composites correctly during transitions: result = dst*(1-a)+col*a
    gl_FragColor = vec4(col, u_opacity);
  }
`

/**
 * Fullscreen quad geometry reused across shader scenes.
 * Position is already in clip space (no matrix needed).
 *
 * WHY two triangles (not THREE.PlaneGeometry): we control the vertex
 *   layout exactly (positions in clip space -1..1, uv 0..1), so the
 *   vertex shader can emit `vec4(position.xy, 0.0, 1.0)` directly
 *   without any projection matrix multiplication. Saves uniform
 *   uploads + a matrix multiply per vertex.
 *
 * SHARED ACROSS SCENES: duplicated in every shader scene file for the
 *   same reason the noise functions are duplicated — no GLSL/JS module
 *   sharing across scene files. ~12 lines per file, not worth a helper.
 */
function fullscreenQuadGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  const verts = new Float32Array([
    -1, -1, 0,
     1, -1, 0,
     1,  1, 0,
    -1, -1, 0,
     1,  1, 0,
    -1,  1, 0,
  ])
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 0,
    1, 1,
    0, 1,
  ])
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  return geo
}

/**
 * LiquidScene — fullscreen procedural plasma shader.
 *
 * Lifecycle:
 *   init()    → builds a fullscreen-quad Mesh + ShaderMaterial with all
 *              uniforms at safe defaults; adds it to a private THREE.Scene.
 *   update()  → per-frame push of VisualState + UserSettings into uniforms.
 *   resize()  → updates u_resolution so aspect correction stays right.
 *   setOpacity() → eased by SceneManager during crossfade transitions.
 *   render()  → issues one draw call (the fullscreen quad).
 *   dispose() → frees the ShaderMaterial program + geometry VBO and nulls
 *              every ref so GC can collect the JS wrappers.
 *
 * WHY OrthographicCamera for a clip-space quad: the vertex shader
 *   writes `gl_Position = vec4(position.xy, 0.0, 1.0)` directly, so
 *   the camera's view/projection matrices are never read. The
 *   OrthographicCamera is just a placeholder — Three.js requires
 *   SOME camera for `renderer.render(scene, camera)`. A PerspectiveCamera
 *   would work equally well here; we use ortho to signal intent (2D).
 */
export class LiquidScene implements Scene {
  readonly id = 'liquid'
  readonly name = 'Liquid Plasma'
  readonly description =
    'Fullscreen flowing noise with fluid distortion and glowing color fields.'

  private material: THREE.ShaderMaterial | null = null
  private mesh: THREE.Mesh | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.OrthographicCamera | null = null

  /**
   * Build the Three.js objects for this scene. Called once by
   * SceneManager.switchTo when this scene becomes the incoming scene.
   *
   * Allocates: a THREE.Scene (container), an OrthographicCamera
   * (placeholder for the renderer API), the ShaderMaterial with all
   * uniforms initialized to safe defaults, and a fullscreen-quad Mesh.
   * `frustumCulled = false` ensures the quad is never skipped (its
   * geometry is in clip space, which confuses Three's frustum-culler).
   */
  init(): void {
    this.scene = new THREE.Scene()
    // orthographic camera works fine for a clip-space fullscreen quad
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
        u_intensity: { value: 1 },
        u_motion: { value: 1 },
        u_glow: { value: 1 },
        u_distortion: { value: 0.5 },
        u_colorShift: { value: 0 },
        u_primary: { value: new THREE.Color('#ff2d95') },
        u_secondary: { value: new THREE.Color('#2d9bff') },
        u_background: { value: new THREE.Color('#05030d') },
        u_particles: { value: 0.5 },
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
   * Per-frame uniform push. Called BEFORE render() by the VisualEngine
   * loop. `state` is the VisualMapper's flattened output; `settings`
   * is the live Zustand store state; `time` is AudioEngine.currentTime.
   *
   * Maps VisualState → shader uniforms 1:1 except for two renames:
   *   state.pulse → u_beat   (state field is named "pulse" because it's
   *                            also used by non-shader paths; the GLSL
   *                            uniform is named "beat" for readability)
   *   state.glow  → u_glow    (state field is the VisualMapper glow output,
   *                            already includes the user's glow setting)
   * `u_intensity` and `u_motion` come straight from UserSettings
   * (not VisualState) so they aren't pre-scaled by reaction curves.
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
    u.u_intensity.value = settings.intensity
    u.u_motion.value = settings.motion
    u.u_glow.value = state.glow
    u.u_distortion.value = state.distortion
    u.u_colorShift.value = state.colorShift
    u.u_primary.value.copy(settings.primaryColor)
    u.u_secondary.value.copy(settings.secondaryColor)
    u.u_background.value.copy(settings.backgroundColor)
    u.u_particles.value = state.particles
  }

  /**
   * Set the crossfade opacity. Called by SceneManager with an eased
   * 0..1 value during transitions. Writes straight to the `u_opacity`
   * uniform; the fragment shader uses it as the alpha channel of
   * `gl_FragColor`.
   */
  setOpacity(o: number): void {
    if (this.material) this.material.uniforms.u_opacity.value = o
  }

  /**
   * Viewport resize. Updates `u_resolution` so the fragment shader
   * can correct the aspect ratio of its UV coords. No camera update
   * is needed (OrthographicCamera is never read by the vertex shader).
   */
  resize(width: number, height: number): void {
    if (this.material) {
      this.material.uniforms.u_resolution.value.set(width, height)
    }
  }

  /**
   * Issue the draw call for this scene. The VisualEngine has already
   * cleared the framebuffer to UserSettings.backgroundColor before
   * calling this, so the scene composites over a known base during
   * crossfades. Single draw call = the fullscreen quad.
   */
  render(renderer: THREE.WebGLRenderer): void {
    if (this.scene && this.camera) {
      renderer.render(this.scene, this.camera)
    }
  }

  /**
   * Free GPU resources. Called by SceneManager after the crossfade
   * completes (when the outgoing scene's opacity has eased to 0).
   * ShaderMaterial.dispose() releases the compiled shader program;
   * geometry.dispose() releases the VBO. Nulling the JS refs lets the
   * Three.js wrappers be GC'd.
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
