import * as THREE from 'three'
import type { Scene } from './Scene'
import type { UserSettings, VisualState } from '../../audio/types'

/**
 * OrbitScene — glowing geometric rings + procedural particles in
 * circular motion (spec §16 Scene 1 — ORBIT).
 *
 * Mappings:
 *   bass → ring size
 *   beat → pulse
 *   mid → rotation speed
 *   treble → particles
 *   energy → glow
 *
 * All geometry is generated in code (rings via TubeGeometry on a
 * Circle curve; particles via Points + ShaderMaterial). No imported
 * textures — particles are shaded procedurally as soft round points.
 */

const PARTICLE_COUNT = 4000

// ============================================================
// PARTICLE VERTEX SHADER — orbits driven on the GPU
// --------------------------------------------------------------
// Each particle is positioned entirely on the GPU from 4 attributes
// (radius, phase, speed, height). The CPU uploads them once at
// init(); per-frame updates are uniform-only (cheap).
//
// Motion model: pure circular orbit in the XY plane with a small Z
// wobble. No physics integration — just `angle = phase + t * speed`
// projected through cos/sin. Bass expands the orbit radius; beat
// gives a brief outward pulse; mid drives the global rotation speed.
// ============================================================
const PARTICLE_VERT = /* glsl */ `
  // ============================================================
  // PARTICLE ATTRIBUTES (per-particle, uploaded once at init)
  // ============================================================
  // SHADER ATTRIBUTE: a_radius
  // Purpose: base orbit radius for this particle
  // Normal range: 0.2..1.4 (set randomly at init)
  // Safe to modify: YES (via the CPU-side positions array — would
  //   require a re-upload of the attribute buffer)
  attribute float a_radius;

  // SHADER ATTRIBUTE: a_phase
  // Purpose: per-particle starting angle (0..2π); spreads particles
  //          around the ring so they don't all bunch at angle 0
  // Safe to modify: YES
  attribute float a_phase;

  // SHADER ATTRIBUTE: a_speed
  // Purpose: per-particle orbit speed multiplier (0.4..2.0)
  //          particles at different speeds create layered rotation
  // Safe to modify: YES
  attribute float a_speed;

  // SHADER ATTRIBUTE: a_height
  // Purpose: base Z position (-0.75..0.75); gives the field depth
  //          instead of being a flat 2D ring
  // Safe to modify: YES
  attribute float a_height;

  // ============================================================
  // PARTICLE UNIFORMS (updated per frame from VisualState)
  // ============================================================

  // SHADER UNIFORM: u_time
  // Purpose: master clock (seconds) from AudioEngine.currentTime
  // Safe to modify: YES
  uniform float u_time;

  // SHADER UNIFORM: u_bass
  // Purpose: low-frequency energy → orbit radius expansion + Z lift
  // Normal range: 0..1
  // Increased: particles fly outward and rise in Z on heavy bass
  // Decreased: tighter orbit, lower Z
  // Safe to modify: YES
  uniform float u_bass;

  // SHADER UNIFORM: u_beat
  // Purpose: short-lived beat pulse → outward radial kick
  // Normal range: 0..1 (decaying)
  // Increased: stronger outward kick on each beat
  // Decreased: no beat pulse
  // Safe to modify: YES
  uniform float u_beat;

  // SHADER UNIFORM: u_mid
  // Purpose: mid-frequency energy → orbit rotation speed
  // Normal range: 0..1
  // Increased: faster orbital motion
  // Decreased: slower rotation
  // Safe to modify: YES
  uniform float u_mid;

  // SHADER UNIFORM: u_motion
  // Purpose: user-facing motion speed multiplier (0..3)
  // Normal range: 0..3
  // Increased: all motion faster
  // Decreased: 0 = particles stationary (only bass/beat impulses move)
  // Safe to modify: YES
  uniform float u_motion;

  // SHADER UNIFORM: u_particles
  // Purpose: user-facing particle-size multiplier (particleAmount)
  // Normal range: 0..1
  // Increased: larger point sprites
  // Decreased: smaller particles
  // Safe to modify: YES
  uniform float u_particles;

  // varying: per-particle brightness (set in VS, read in FS)
  varying float v_brightness;

  // ============================================================
  // MAIN — compute particle position + brightness
  // ============================================================
  void main() {
    // ============================================================
    // PARTICLE MOTION (orbit angle)
    // --------------------------------------------------------------
    // Angle = phase + t * speed. t scales with motion + mid so the
    // whole field rotates faster on intense audio. a_speed gives
    // per-particle variation so the rings shear apart over time.
    // ============================================================
    float t = u_time * (0.3 + u_motion * 0.8 + u_mid * 1.5) * (0.6 + a_speed);
    // orbit angle: base position + per-particle phase + time
    float ang = a_phase + t;

    // ============================================================
    // PARTICLE POSITION (orbit + Z wobble)
    // --------------------------------------------------------------
    // radius scales with bass + beat → bass expands the whole ring,
    // beat kicks it outward briefly. Z is the base height + a sin
    // wobble for life (avoids a perfectly flat field).
    // ============================================================
    float radius = a_radius * (1.0 + u_bass * 0.6 + u_beat * 0.4);
    vec3 pos = vec3(cos(ang) * radius, sin(ang) * radius, a_height * (1.0 + u_bass * 0.3));
    // small vertical wobble for life
    pos.z += sin(u_time * 0.7 + a_phase * 3.0) * 0.2;

    // ============================================================
    // CLIP-SPACE PROJECTION
    // --------------------------------------------------------------
    // modelViewMatrix + projectionMatrix are auto-injected by three.js
    // for ShaderMaterials (the only built-in matrices we use here).
    // ============================================================
    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPos;

    // ============================================================
    // POINT SIZE
    // --------------------------------------------------------------
    // gl_PointSize is in pixels. Scaled by 1/-mvPos.z so distant
    // particles shrink (perspective foreshortening). u_particles +
    // a_radius grow the size; treble contributes via the FS only.
    // ============================================================
    // particle size shrinks with distance; grows with treble/particles
    float size = (4.0 + a_radius * 12.0) * (0.5 + u_particles * 1.5);
    gl_PointSize = size * (1.0 / -mvPos.z);

    // ============================================================
    // BRIGHTNESS VARYING
    // --------------------------------------------------------------
    // Sin of 2*angle gives a 2-cycle brightness pattern around the
    // ring → particles fade in/out as they orbit (twinkle).
    // ============================================================
    // brightness falls off toward the edge of the orbit
    v_brightness = 0.5 + 0.5 * sin(ang * 2.0 + u_time);
  }
`

// ============================================================
// PARTICLE FRAGMENT SHADER — procedural soft disk
// --------------------------------------------------------------
// gl_PointCoord is 0..1 across the point sprite. We compute a soft
// radial falloff (smoothstep + pow) to make a round disk instead of
// the default square point sprite. Discards near-transparent pixels.
// ============================================================
const PARTICLE_FRAG = /* glsl */ `
  precision highp float;
  varying float v_brightness;

  // SHADER UNIFORM: u_primary
  // Purpose: primary particle color (pink/magenta)
  // Safe to modify: YES
  uniform vec3 u_primary;

  // SHADER UNIFORM: u_secondary
  // Purpose: secondary particle color (blue); blended by brightness
  // Safe to modify: YES
  uniform vec3 u_secondary;

  // SHADER UNIFORM: u_glow
  // Purpose: glow strength → brightness multiplier + additive boost
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_glow;

  // SHADER UNIFORM: u_energy
  // Purpose: overall energy → brightness
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_energy;

  // SHADER UNIFORM: u_colorShift
  // Purpose: signed (-1..1) hue offset between primary/secondary mix
  // Safe to modify: YES
  uniform float u_colorShift;

  // SHADER UNIFORM: u_opacity
  // Purpose: crossfade alpha (driven by setOpacity)
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_opacity;

  void main() {
    // ============================================================
    // SOFT DISK FALLOFF
    // --------------------------------------------------------------
    // gl_PointCoord is the 0..1 uv of the point sprite. Center → 0.5,
    // edge → 0 or 1. length(d)*2 makes 0 at center, 1 at the edge.
    // smoothstep(1.0, 0.0, r) = 1 at center, 0 at edge (soft falloff).
    // pow(alpha, 1.5) tightens the disk core (sharper center, softer
    // halo) — gives a more "glowing orb" look than linear falloff.
    // discard on near-zero alpha = skips blending fully transparent
    // pixels (saves fill rate on dense particle fields).
    // ============================================================
    // gl_PointCoord is 0..1 across the point sprite
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    // soft disk falloff
    float alpha = smoothstep(1.0, 0.0, r);
    alpha = pow(alpha, 1.5);
    if (alpha < 0.01) discard;

    // ============================================================
    // COLOR (primary/secondary mix + brightness/glow)
    // --------------------------------------------------------------
    // mix primary → secondary along (brightness + colorShift). The
    // '(1.0 + u_glow * 0.5)' post-multiply is the "additive brighten"
    // — boosts already-bright pixels more than dark ones (clipping to
    // white at high glow), which is the cheap substitute for a bloom
    // post-process pass.
    // ============================================================
    // mix primary/secondary based on brightness and colorShift
    vec3 col = mix(u_primary, u_secondary, clamp(v_brightness + u_colorShift * 0.5, 0.0, 1.0));
    col *= (0.4 + u_energy * 1.3 + u_glow * 0.6) * v_brightness;
    // additive-ish brightening for glow
    col = col * (1.0 + u_glow * 0.5);

    // ============================================================
    // OUTPUT — non-premultiplied alpha + AdditiveBlending
    // --------------------------------------------------------------
    // WHY non-premultiplied here when LiquidScene uses NormalBlending:
    //   AdditiveBlending uses blendFunc(SRC_ALPHA, ONE), giving
    //   'result = dst + col * alpha'. The color must NOT be pre-
    //   multiplied (else we'd get col*alpha*alpha = double-darkened).
    //   This is the correct pairing for additive particles: straight
    //   RGB out, alpha modulates the contribution.
    // WHY AdditiveBlending for particles (vs NormalBlending): additive
    //   = "light particles" that brighten whatever is behind them —
    //   overlapping particles glow brighter instead of occluding each
    //   other. The classic "neon dust" look.
    // ============================================================
    // non-premultiplied: AdditiveBlending does dst + col * alpha
    gl_FragColor = vec4(col, alpha * u_opacity);
  }
`

/**
 * Ring shader: draws thick glowing rings. We render a fullscreen
 * shader with several concentric rings whose size/rotation react to
 * bass / mid / beat. Cheaper and prettier than real geometry for an
 * MVP because it gives us free glow.
 */
const RING_VERT = /* glsl */ `
  // ============================================================
  // RING VERTEX SHADER — fullscreen pass-through
  // ============================================================
  // COORDINATE SYSTEM: clip space (-1..1), no matrix needed
  // ============================================================
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const RING_FRAG = /* glsl */ `
  // ============================================================
  // RING FRAGMENT SHADER — concentric glowing rings
  // --------------------------------------------------------------
  // Pipeline (top to bottom):
  //   1. UNIFORMS           — audio + visual + color inputs
  //   2. NOISE PRIMITIVES   — hash2 / vnoise / fbm (shared pattern)
  //   3. rings(uv, t)       — concentric ring SDF with fbm distortion
  //   4. main():
  //        COORDINATE SYSTEM — center uv + aspect correction
  //        FLOW SPEED        — master clock scaled by motion + mid
  //        DOMAIN WARP       — small uv offset for organic flow
  //        BACKGROUND        — tinted with noise so it isn't flat
  //        RING COLOR        — primary/secondary mix by angle + shift
  //        CENTER GLOW       — beat-driven central glow halo
  //        BRIGHTNESS/GLOW   — overall brightness multipliers
  //        VIGNETTE          — darken edges
  //        CROSSFADE ALPHA   — non-premultiplied output
  // ============================================================
  precision highp float;
  varying vec2 vUv;

  // SHADER UNIFORM: u_resolution
  // Purpose: drawing-buffer size; aspect correction
  // Safe to modify: YES
  uniform vec2  u_resolution;

  // SHADER UNIFORM: u_time
  // Purpose: master clock (seconds)
  // Safe to modify: YES
  uniform float u_time;

  // SHADER UNIFORM: u_bass
  // Purpose: low-frequency energy → ring radius expansion
  // Normal range: 0..1
  // Increased: rings expand outward
  // Decreased: rings contract
  // Safe to modify: YES
  uniform float u_bass;

  // SHADER UNIFORM: u_mid
  // Purpose: mid-frequency energy → flow speed multiplier
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_mid;

  // SHADER UNIFORM: u_treble
  // Purpose: high-frequency energy → ring fade-in (outer rings brighten)
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_treble;

  // SHADER UNIFORM: u_energy
  // Purpose: overall energy → ring brightness
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_energy;

  // SHADER UNIFORM: u_beat
  // Purpose: short-lived beat pulse → outward ring pulse + center glow
  // Normal range: 0..1 (decaying)
  // Safe to modify: YES
  uniform float u_beat;

  // SHADER UNIFORM: u_motion
  // Purpose: global motion speed multiplier
  // Normal range: 0..3
  // Safe to modify: YES
  uniform float u_motion;

  // SHADER UNIFORM: u_glow
  // Purpose: glow / bloom strength
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_glow;

  // SHADER UNIFORM: u_distortion
  // Purpose: ring radius fbm-distortion amplitude
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_distortion;

  // SHADER UNIFORM: u_colorShift
  // Purpose: signed (-1..1) palette phase offset
  // Safe to modify: YES
  uniform float u_colorShift;

  // SHADER UNIFORM: u_primary
  // Purpose: primary ring color
  // Safe to modify: YES
  uniform vec3  u_primary;

  // SHADER UNIFORM: u_secondary
  // Purpose: secondary ring color
  // Safe to modify: YES
  uniform vec3  u_secondary;

  // SHADER UNIFORM: u_background
  // Purpose: background color (tinted with noise for non-flat look)
  // Safe to modify: YES
  uniform vec3  u_background;

  // SHADER UNIFORM: u_opacity
  // Purpose: crossfade alpha (0..1)
  // Safe to modify: YES
  uniform float u_opacity;

  // ============================================================
  // SECTION 2 — NOISE PRIMITIVES (shared with other scenes)
  // --------------------------------------------------------------
  // hash + fbm (same as LiquidScene — small duplication is fine for
  // an MVP rather than sharing a GLSL include across files).
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
  // SECTION 3 — SHAPE DEFINITION (concentric ring SDF)
  // --------------------------------------------------------------
  // Draws N concentric rings, each with its own phase/speed/size.
  // For each ring i:
  //   - baseR = 0.15 + i*0.18          (rings spaced 0.18 apart)
  //   - radius *= (1 + bass*0.5 + beat*0.2)  (audio expands rings)
  //   - radius += fbm-distortion       (organic wobble, not perfect circle)
  //   - thick = 0.012..0.020           (inner rings slightly thicker)
  //   - acc += smoothstep-based ring intensity
  //
  // WHY N=5 (constant): 5 rings give enough density for visual interest
  //   without crowding. GLSL requires constant loop bounds in WebGL1,
  //   so N must be 'const int'. CUSTOMIZATION: change 'const int N = 5'
  //   to 3 (sparser) or 8 (denser) — both render fine.
  // ============================================================
  // draw N concentric rings whose radius rotates with time
  float rings(vec2 uv, float t) {
    float r = length(uv);
    float ang = atan(uv.y, uv.x);
    // a few rings, each with its own speed and phase
    float acc = 0.0;
    const int N = 5;
    for (int i = 0; i < N; i++) {
      float fi = float(i);
      float baseR = 0.15 + fi * 0.18;
      // bass expands the rings; beat pushes them outward in a pulse
      float radius = baseR * (1.0 + u_bass * 0.5 + u_beat * 0.2);
      // distortion warps the ring with noise
      float n = fbm(vec2(ang * 3.0 + t * 0.5 + fi * 1.7, fi));
      float rr = radius + n * 0.08 * (1.0 + u_distortion * 2.0);
      // ring thickness
      float thick = 0.012 + 0.008 * (1.0 - fi / float(N));
      float ring = smoothstep(thick, 0.0, abs(r - rr));
      // fade outer rings with treble
      acc += ring * (0.9 - fi * 0.1) * (0.5 + u_treble * 0.7);
    }
    return acc;
  }

  // ============================================================
  // SECTION 4 — MAIN: ring composition pipeline
  // ============================================================
  void main() {
    // ============================================================
    // COORDINATE SYSTEM (center uv + aspect correction)
    // ============================================================
    vec2 uv = (vUv - 0.5);
    uv.x *= u_resolution.x / u_resolution.y;

    // ============================================================
    // FLOW SPEED (master time multiplier)
    // ============================================================
    float t = u_time * (0.15 + u_motion * 0.4 + u_mid * 0.6);

    // ============================================================
    // DOMAIN WARP (subtle, just to give the rings organic motion)
    // ============================================================
    // slight domain warp for organic flow
    vec2 q = uv + 0.15 * vec2(fbm(uv * 2.0 + t), fbm(uv * 2.0 - t));
    float r = rings(q, t);

    // ============================================================
    // BACKGROUND (tinted with noise, not flat)
    // ============================================================
    // background tint with subtle noise so it isn't pure flat
    float bgN = 0.5 + 0.5 * fbm(uv * 3.0 + t * 0.2);
    vec3 col = mix(u_background, u_background * 1.4, bgN * 0.4);

    // ============================================================
    // RING COLOR (primary/secondary mix by angle + colorShift)
    // --------------------------------------------------------------
    // sin(ang*2 + t + colorShift*3) creates a 2-cycle color sweep
    // around the rings — so the rings aren't all one color, they
    // have primary↔secondary segments rotating over time.
    // ============================================================
    // ring color: lerp primary→secondary along the angle and color shift
    float ang = atan(q.y, q.x);
    vec3 ringCol = mix(u_primary, u_secondary, 0.5 + 0.5 * sin(ang * 2.0 + t + u_colorShift * 3.0));
    col += ringCol * r * (0.6 + u_glow * 1.0 + u_energy * 1.0);

    // ============================================================
    // CENTER GLOW (beat-driven)
    // --------------------------------------------------------------
    // smoothstep(0.3, 0.0, center) = bright at center, fades outward.
    // Beat multiplies — kicks of brightness on each beat pulse.
    // ============================================================
    // central glow on beat
    float center = length(q);
    col += u_primary * smoothstep(0.3, 0.0, center) * (0.2 + u_beat * 0.9);

    // ============================================================
    // BRIGHTNESS / GLOW (overall multipliers)
    // ============================================================
    // overall brightness / glow
    col *= 0.4 + u_energy * 1.0 + u_glow * 0.4;
    col *= 1.0 + u_beat * 0.3;

    // ============================================================
    // VIGNETTE (darken edges to focus on center)
    // ============================================================
    // vignette
    col *= 1.0 - 0.4 * smoothstep(0.5, 1.4, length(uv));

    // ============================================================
    // CROSSFADE ALPHA (non-premultiplied for NormalBlending)
    // ============================================================
    // non-premultiplied alpha for crossfade compositing
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

/**
 * OrbitScene — concrete Scene implementing spec §16 Scene 1.
 *
 * Lifecycle:
 *   init()    → builds two draw layers: a fullscreen-quad ring shader
 *              (rings + background) and a 4000-particle THREE.Points
 *              with additive blending. Both share a PerspectiveCamera.
 *   update()  → pushes VisualState + UserSettings into BOTH materials'
 *              uniforms each frame (the ring material gets audio/state,
 *              the particle material gets a subset — particle uniforms
 *              don't need u_treble etc. since they're computed in FS).
 *   resize()  → updates u_resolution on the ring shader + camera.aspect
 *              on the perspective camera (the particle shader uses
 *              gl_PointSize in pixels and doesn't need u_resolution).
 *   setOpacity() → writes to BOTH materials' u_opacity so the
 *              crossfade affects the rings AND the particles together.
 *   render()  → one draw call (three renders both objects in scene).
 *   dispose() → frees 2 ShaderMaterials + 2 geometries (ring quad +
 *              particle buffer). Nulls all 6 fields for GC.
 *
 * WHY a PerspectiveCamera (not Ortho like LiquidScene): the particle
 *   field is in 3D world space (a_height gives Z depth) so we need
 *   perspective foreshortening for distant particles to shrink. The
 *   ring fullscreen quad ALSO uses this camera but its vertex shader
 *   ignores the camera matrices (writes clip-space coords directly),
 *   so the camera choice is irrelevant to the ring layer.
 */
export class OrbitScene implements Scene {
  readonly id = 'orbit'
  readonly name = 'Orbit'
  readonly description =
    'Glowing geometric rings and particles in circular motion with radial symmetry.'

  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private ringMaterial: THREE.ShaderMaterial | null = null
  private ringMesh: THREE.Mesh | null = null
  private particleMaterial: THREE.ShaderMaterial | null = null
  private particles: THREE.Points | null = null

  /**
   * Build both layers + camera. Called once by SceneManager.switchTo.
   *
   * Allocates: THREE.Scene (container), PerspectiveCamera (60° FOV,
   * positioned at z=3 looking at origin — far enough to see rings of
   * radius 0.15..0.87), the ring ShaderMaterial (NormalBlending) +
   * fullscreen-quad mesh, and the particle ShaderMaterial
   * (AdditiveBlending) + THREE.Points with 4000 vertices.
   *
   * WHY particleMaterial uses AdditiveBlending + ringMaterial uses
   *   NormalBlending: additive particles glow over the rings (light
   *   adding to color), while the rings composite correctly during
   *   crossfades (alpha blend over the cleared background). Two
   *   different blend modes for two different visual intents.
   */
  init(): void {
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
    this.camera.position.set(0, 0, 3)
    this.camera.lookAt(0, 0, 0)

    // fullscreen ring shader
    this.ringMaterial = new THREE.ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
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
    this.ringMesh = new THREE.Mesh(fullscreenQuadGeometry(), this.ringMaterial)
    this.ringMesh.frustumCulled = false
    this.scene.add(this.ringMesh)

    // procedural particles
    const geo = new THREE.BufferGeometry()
    // positions are computed in the vertex shader from a_radius/a_phase/
    // a_speed/a_height, but Three.js still requires a valid `position`
    // attribute to compute the bounding sphere and avoid NaN culling.
    // We seed it with dummy zero values; the actual positions are
    // derived per-frame on the GPU.
    const positions = new Float32Array(PARTICLE_COUNT * 3)
    const radii = new Float32Array(PARTICLE_COUNT)
    const phases = new Float32Array(PARTICLE_COUNT)
    const speeds = new Float32Array(PARTICLE_COUNT)
    const heights = new Float32Array(PARTICLE_COUNT)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      radii[i] = 0.2 + Math.random() * 1.2
      phases[i] = Math.random() * Math.PI * 2
      speeds[i] = 0.4 + Math.random() * 1.6
      heights[i] = (Math.random() - 0.5) * 1.5
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('a_radius', new THREE.BufferAttribute(radii, 1))
    geo.setAttribute('a_phase', new THREE.BufferAttribute(phases, 1))
    geo.setAttribute('a_speed', new THREE.BufferAttribute(speeds, 1))
    geo.setAttribute('a_height', new THREE.BufferAttribute(heights, 1))
    geo.computeBoundingSphere() // safe now that position is the right size

    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        u_time: { value: 0 },
        u_bass: { value: 0 },
        u_beat: { value: 0 },
        u_mid: { value: 0 },
        u_motion: { value: 1 },
        u_particles: { value: 0.5 },
        u_primary: { value: new THREE.Color('#ff2d95') },
        u_secondary: { value: new THREE.Color('#2d9bff') },
        u_glow: { value: 1 },
        u_energy: { value: 0 },
        u_colorShift: { value: 0 },
        u_opacity: { value: 1 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.particles = new THREE.Points(geo, this.particleMaterial)
    this.particles.frustumCulled = false
    this.scene.add(this.particles)
  }

  /**
   * Per-frame uniform push to BOTH materials. The ring material
   * receives the full audio+visual+color set; the particle material
   * receives a subset (no u_treble/u_distortion/u_background — the
   * particle shader doesn't use them). Splitting the writes keeps
   * unused uniforms from being set with stale values.
   *
   * Same VisualState → uniform renames as LiquidScene:
   *   state.pulse → u_beat
   *   state.glow  → u_glow (already includes user's glow setting)
   */
  update(state: VisualState, settings: UserSettings, time: number): void {
    if (this.ringMaterial) {
      const u = this.ringMaterial.uniforms
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
      u.u_primary.value.copy(settings.primaryColor)
      u.u_secondary.value.copy(settings.secondaryColor)
      u.u_background.value.copy(settings.backgroundColor)
    }
    if (this.particleMaterial) {
      const u = this.particleMaterial.uniforms
      u.u_time.value = time
      u.u_bass.value = state.bass
      u.u_beat.value = state.pulse
      u.u_mid.value = state.mid
      u.u_motion.value = settings.motion
      u.u_particles.value = state.particles
      u.u_primary.value.copy(settings.primaryColor)
      u.u_secondary.value.copy(settings.secondaryColor)
      u.u_glow.value = state.glow
      u.u_energy.value = state.energy
      u.u_colorShift.value = state.colorShift
    }
  }

  /**
   * Set crossfade opacity on BOTH materials so rings + particles
   * fade together. If we forgot one, the rings could be invisible
   * while particles linger (or vice versa) — visible artifact.
   */
  setOpacity(o: number): void {
    if (this.ringMaterial) this.ringMaterial.uniforms.u_opacity.value = o
    if (this.particleMaterial) this.particleMaterial.uniforms.u_opacity.value = o
  }

  /**
   * Viewport resize. The ring shader gets u_resolution updated; the
   * camera gets aspect + projection-matrix update (needed for the
   * particle layer to render with correct perspective).
   *
   * WARNING: must update camera.aspect BEFORE updateProjectionMatrix;
   * the latter reads the former.
   */
  resize(width: number, height: number): void {
    if (this.ringMaterial) {
      this.ringMaterial.uniforms.u_resolution.value.set(width, height)
    }
    if (this.camera) {
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    }
  }


  /**
   * Issue one renderer.render call. Three's render loop draws both
   * the ring mesh and the THREE.Points object in this scene in a
   * single batch (the order they were added to the scene).
   * VisualEngine clears the framebuffer to backgroundColor before
   * calling this so crossfade compositing works.
   */
  render(renderer: THREE.WebGLRenderer): void {
    if (this.scene && this.camera) {
      renderer.render(this.scene, this.camera)
    }
  }

  /**
   * Free GPU resources. Called by SceneManager after crossfade-out.
   * Disposes 2 ShaderMaterials (ring + particle) + 2 geometries
   * (fullscreen-quad + particle buffer). Nulls all 6 fields so the
   * Three.js wrappers can be GC'd. Forgetting to dispose either
   * material leaks the shader program — a hard GPU leak.
   */
  dispose(): void {
    this.ringMaterial?.dispose()
    this.particleMaterial?.dispose()
    this.ringMesh?.geometry.dispose()
    this.particles?.geometry.dispose()
    this.scene = null
    this.camera = null
    this.ringMesh = null
    this.particles = null
    this.ringMaterial = null
    this.particleMaterial = null
  }
}
