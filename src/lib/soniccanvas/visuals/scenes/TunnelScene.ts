import * as THREE from 'three'
import type { Scene } from './Scene'
import type { UserSettings, VisualState } from '../../audio/types'

/**
 * TunnelScene (spec §16 Scene 4 — TUNNEL)
 *
 * Visual concept:
 *   * infinite-feeling tunnel
 *   * repeating geometric structures
 *   * forward motion
 *   * perspective-like depth
 *   * pulsing walls
 *
 * Mappings:
 *   bass → tunnel width
 *   beat → forward impulse
 *   mid → rotation
 *   treble → detail
 *   energy → speed
 *
 * Implemented as a fullscreen shader using polar coordinates + a
 * pseudo-3D tunnel projection (classic "polar tunnel" / repetition
 * technique). No 3D models — purely procedural.
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
  // FRAGMENT SHADER — Tunnel (pseudo-3D polar tunnel)
  // --------------------------------------------------------------
  // Pipeline (top to bottom):
  //   1. UNIFORMS         — audio + visual + color inputs
  //   2. NOISE PRIMITIVES — hash2 / vnoise / fbm (value noise FBM)
  //   3. main():
  //        COORDINATE SYSTEM       — center uv + aspect correction
  //        TUNNEL CENTER            — small wobble for life
  //        POLAR PROJECTION         — r, ang from center; bass opens width
  //        DEPTH + ANGULAR TEXTURE  — depth = 1/r (perspective) + beat z-kick
  //        DISTORTION               — fbm warps the wall texture
  //        WALL PATTERN             — rings + stripes combined
  //        FINE DETAIL              — high-freq fbm scaled by treble
  //        BASE COLOR               — secondary (far) → primary (near)
  //        DISTANCE FOG             — far walls fade to background
  //        EDGE GLOW                — atmospheric perspective on tunnel edges
  //        BEAT PULSE                — bright ring expanding outward
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
  // Same uniform convention as LiquidScene (u_<name>, 0..1 unless noted).
  // --------------------------------------------------------------

  // SHADER UNIFORM: u_resolution
  // Purpose: drawing-buffer size in pixels; aspect correction
  // Safe to modify: YES (set via resize())
  uniform vec2  u_resolution;

  // SHADER UNIFORM: u_time
  // Purpose: master clock (seconds) from AudioEngine.currentTime
  // Safe to modify: YES
  uniform float u_time;

  // SHADER UNIFORM: u_bass
  // Purpose: low-frequency energy → tunnel width (negative coefficient —
  //          bass OPENS the walls outward)
  // Normal range: 0..1
  // Increased: wider tunnel (walls pushed outward)
  // Decreased: narrower tunnel (tighter view)
  // Safe to modify: YES
  uniform float u_bass;

  // SHADER UNIFORM: u_mid
  // Purpose: mid-frequency energy → tunnel-center wobble (life)
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_mid;

  // SHADER UNIFORM: u_treble
  // Purpose: high-frequency energy → fine-detail octave amplitude
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_treble;

  // SHADER UNIFORM: u_energy
  // Purpose: overall energy → forward motion speed + brightness
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_energy;

  // SHADER UNIFORM: u_beat
  // Purpose: short-lived beat pulse → forward z-kick + expanding ring
  // Normal range: 0..1 (decaying)
  // Safe to modify: YES
  uniform float u_beat;

  // SHADER UNIFORM: u_motion
  // Purpose: global motion speed multiplier
  // Normal range: 0..3
  // Safe to modify: YES
  uniform float u_motion;

  // SHADER UNIFORM: u_glow
  // Purpose: glow strength (edge glow + brightness)
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_glow;

  // SHADER UNIFORM: u_distortion
  // Purpose: wall-texture fbm-distortion amplitude
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_distortion;

  // SHADER UNIFORM: u_colorShift
  // Purpose: signed (-1..1) hue offset (used in color mix)
  // Safe to modify: YES
  uniform float u_colorShift;

  // SHADER UNIFORM: u_intensity
  // Purpose: master brightness multiplier (final col *= u_intensity)
  // Normal range: 0..3
  // Safe to modify: YES
  uniform float u_intensity;

  // SHADER UNIFORM: u_particles
  // Purpose: particle-activity multiplier for the fine-detail layer
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_particles;

  // SHADER UNIFORM: u_primary
  // Purpose: primary wall color (near)
  // Safe to modify: YES
  uniform vec3  u_primary;

  // SHADER UNIFORM: u_secondary
  // Purpose: secondary wall color (far)
  // Safe to modify: YES
  uniform vec3  u_secondary;

  // SHADER UNIFORM: u_background
  // Purpose: background color (distance fog target)
  // Safe to modify: YES
  uniform vec3  u_background;

  // SHADER UNIFORM: u_opacity
  // Purpose: crossfade alpha (0..1)
  // Safe to modify: YES
  uniform float u_opacity;

  // ============================================================
  // SECTION 2 — NOISE PRIMITIVES (shared pattern with other scenes)
  // ============================================================
  // hash + value noise (shared pattern with other scenes)
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
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = m * p * 2.02;
      a *= 0.5;
    }
    return v;
  }

  // ============================================================
  // SECTION 3 — MAIN: pseudo-3D tunnel pipeline
  // --------------------------------------------------------------
  // Pseudo-3D Tunnel Concept:
  //   Classic "polar tunnel" technique. UV is treated as a 2D plane
  //   viewed face-on; we convert to polar (r, ang) where r is the
  //   distance from screen center. As r → 0 the wall appears to
  //   recede to infinity (perspective). Forward motion comes from
  //   animating z = time * speed; the depth coordinate is 1/r + z,
  //   which creates the "flying forward through rings" effect.
  //
  // Reference: https://iquilezles.org/articles/warp/ and various
  //   ShaderToy tunnel demos. No 3D mesh — purely procedural.
  // ============================================================
  // Pseudo-3D tunnel: project UV into a polar tunnel coordinate where
  // r is the radius (distance from center) and ang is the angle.
  // Forward motion comes from animating the depth coordinate z.
  // Returns a tunnel-space coordinate (u, v, z) that we then use for
  // repeated pattern sampling.
  void main() {
    // ============================================================
    // COORDINATE SYSTEM (center uv + aspect correction)
    // ============================================================
    vec2 uv = (vUv - 0.5);
    uv.x *= u_resolution.x / u_resolution.y;

    // ============================================================
    // TUNNEL CENTER (small wobble for life)
    // --------------------------------------------------------------
    // mid drives a small Lissajous wobble so the tunnel "breathes"
    // and shifts slightly with mid-frequency audio. Without this,
    // the dead-center screen pixel is always at r=0 and produces
    // a noisy singular pixel that flickers frame-to-frame.
    // ============================================================
    // tunnel center, slight wobble from mid for life
    vec2 c = uv + 0.05 * vec2(
      sin(u_time * 0.3 + u_mid * 2.0),
      cos(u_time * 0.27 + u_mid * 2.0)
    );

    float r = length(c);
    float ang = atan(c.y, c.x);

    // ============================================================
    // POLAR PROJECTION (depth + speed)
    // --------------------------------------------------------------
    // speed = base 0.4 + motion + energy (energy accelerates the
    //   forward motion so intense passages fly faster through the
    //   tunnel). z = time*speed + beat*0.8 — beat gives a forward
    //   kick (a small "jolt" forward on each beat).
    // width = 0.6 - bass*0.25 — bass OPENS the walls outward (the
    //   negative coefficient is intentional: bigger bass = smaller
    //   width value = wider-looking tunnel because the fog/edge
    //   calculations are scaled against width).
    // ============================================================
    // tunnel depth: animates forward; bass expands radius, beat gives
    // a forward impulse (z jumps), energy accelerates motion.
    float speed = 0.4 + u_motion * 0.8 + u_energy * 1.5;
    float z = u_time * speed + u_beat * 0.8;

    // tunnel "width" — closer to 0 = wider tunnel (less radius). bass
    // opens the walls outward.
    float width = 0.6 - u_bass * 0.25;

    // ============================================================
    // DEPTH + ANGULAR TEXTURE COORDS
    // --------------------------------------------------------------
    // depth = 1/r + z — the 1/r term creates the perspective:
    //   as r → 0 (center), depth → infinity (the tunnel "recedes");
    //   as r → 1 (edge), depth is small (nearby walls).
    //   max(r, 0.0001) guards against divide-by-zero at r=0.
    // uCoord = ang/π * 8 = 8 "panels" around the circumference,
    //   creating a faceted/segmented wall look.
    // ============================================================
    // convert (r, ang, z) to repeating texture coords
    // depth along the tunnel:
    float depth = 1.0 / max(r, 0.0001) + z;
    // angular "wall texture" coordinate
    float uCoord = ang / 3.14159 * 8.0; // 8 wall panels around
    vec2 tun = vec2(uCoord, depth);

    // ============================================================
    // DISTORTION (wall texture warp)
    // --------------------------------------------------------------
    // fbm warps the (uCoord, depth) coords before pattern sampling
    // so the walls have organic motion instead of perfectly straight
    // bands. distortion + bass scale the warp amplitude.
    // ============================================================
    // distortion warps the wall texture for organic feel
    float n = fbm(tun * 1.5 + vec2(0.0, u_time * 0.1));
    tun += (n - 0.5) * (0.2 + u_distortion * 0.6);

    // ============================================================
    // WALL PATTERN (rings + stripes)
    // --------------------------------------------------------------
    // ring = sin(tun.y * 2π * 2) = 2 rings per unit depth — creates
    //   the perpendicular "rings" you fly through.
    // stripe = sin(tun.x * 2π * 0.5) = axial stripes (parallel to
    //   motion) — creates the "panel seams" along the tunnel.
    // smoothstep combines them into a 0..1 pattern value + noise
    //   for organic variation.
    // ============================================================
    // wall pattern: repeating bands perpendicular to motion (rings)
    // combined with axial stripes
    float ring = sin(tun.y * 6.28318 * 2.0); // 2 rings per unit
    float stripe = sin(tun.x * 6.28318 * 0.5);
    float pattern = smoothstep(0.0, 0.6, ring * 0.6 + stripe * 0.4 + n * 0.3);

    // ============================================================
    // FINE DETAIL (high-freq octave, scaled by treble + particles)
    // ============================================================
    // treble adds fine detail
    float detail = fbm(tun * 6.0 + u_time * 0.2);
    pattern += (detail - 0.5) * (0.2 + u_treble * 0.5 + u_particles * 0.3);

    // ============================================================
    // BASE COLOR (secondary far → primary near)
    // --------------------------------------------------------------
    // wallCol mixes secondary→primary by 'pattern' (so bright bands
    //   are primary, dark bands are secondary). depthFade uses
    //   fract(depth) to fade within each ring repetition — gives a
    //   subtle per-ring variation. (NOTE: depthFade is computed but
    //   not used below; kept for future use / readability of the
    //   intent. Removing it doesn't change the rendered output.)
    // ============================================================
    // base color: gradient along depth from secondary (far) → primary (near)
    float depthFade = smoothstep(0.0, 4.0, depth - floor(depth));
    vec3 wallCol = mix(u_secondary, u_primary, pattern);

    // ============================================================
    // DISTANCE FOG (far walls fade into background)
    // --------------------------------------------------------------
    // fog = smoothstep(0, 0.4, r/width) → 0 near center, 1 at edges.
    // mix(background, wallCol, fog) → background-tinted at the
    //   center (far walls blend into the fog), full wall color at
    //   the edges (near walls).
    // ============================================================
    // distance fog — far walls fade into background
    float fog = smoothstep(0.0, 0.4, r / width);
    vec3 col = mix(u_background, wallCol, fog);

    // ============================================================
    // EDGE GLOW (atmospheric perspective)
    // --------------------------------------------------------------
    // At r ≈ 0.8*width (the tunnel edge), walls get a secondary-color
    // glow with intensity scaled by glow. Mimics atmospheric
    // perspective — distant fog is brighter than the foreground.
    // ============================================================
    // edges of the tunnel glow brighter (atmospheric perspective)
    float edge = smoothstep(0.0, 0.1, abs(r - width * 0.8));
    col += u_secondary * (1.0 - edge) * (0.3 + u_glow * 0.6);

    // ============================================================
    // BEAT PULSE (bright ring expanding outward)
    // --------------------------------------------------------------
    // Same expanding-ring technique as LiquidScene's beat shockwave,
    // but smaller radius (0.6 max). Beat decays → ring expands
    // outward → fades as it reaches the tunnel edge.
    // ============================================================
    // beat pulse: bright ring expanding outward
    if (u_beat > 0.001) {
      float beatR = (1.0 - u_beat) * 0.6 + 0.05;
      float beatRing = smoothstep(0.05, 0.0, abs(r - beatR));
      col += (u_primary + u_secondary) * 0.6 * beatRing * u_beat;
    }

    // ============================================================
    // BRIGHTNESS / GLOW (overall multipliers + intensity master)
    // ============================================================
    // brightness / intensity
    col *= 0.5 + u_energy * 1.3 + u_glow * 0.3;
    col *= u_intensity;

    // ============================================================
    // VIGNETTE (closer to center is brighter)
    // --------------------------------------------------------------
    // Inverted vignette compared to LiquidScene: here the center is
    // brighter (you're looking "down" the tunnel toward a bright
    // far point). smoothstep(0.7, 0, r) → 1 at center, 0 at edges.
    // ============================================================
    // vignette (closer to center is brighter)
    col *= 0.4 + 0.6 * smoothstep(0.7, 0.0, r);

    // ============================================================
    // TONEMAP (Reinhard-style soft clip)
    // --------------------------------------------------------------
    // Same cheap tonemap as LiquidScene: col / (1 + col*0.4). Soft-
    // clips bright areas to avoid harsh white bands at high intensity.
    // ============================================================
    // cheap tonemap
    col = col / (1.0 + col * 0.4);

    // ============================================================
    // CROSSFADE ALPHA (non-premultiplied output for NormalBlending)
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

export class TunnelScene implements Scene {
  readonly id = 'tunnel'
  readonly name = 'Tunnel'
  readonly description =
    'Infinite-feeling tunnel with forward motion, repeating walls, and pulsing depth.'

  private material: THREE.ShaderMaterial | null = null
  private mesh: THREE.Mesh | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.OrthographicCamera | null = null

  /**
   * Build the fullscreen-quad Mesh + ShaderMaterial. Called once
   * when this scene becomes active. Uniforms are initialized to
   * safe defaults (1 for intensity/motion/glow, 0 for audio).
   * `frustumCulled = false` because clip-space geometry confuses
   * three's frustum-culler.
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
   * LiquidScene (state.pulse → u_beat, state.glow → u_glow). This
   * scene uses ALL uniforms including u_intensity (some scenes
   * skip it because VisualState.brightness already captures it —
   * TunnelScene keeps the master multiplier for sharper control).
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
   * Issue one draw call (the fullscreen quad). The VisualEngine
   * clears the framebuffer to backgroundColor before calling this
   * so crossfade compositing works.
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
