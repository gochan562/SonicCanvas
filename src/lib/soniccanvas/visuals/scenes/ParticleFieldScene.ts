import * as THREE from 'three'
import type { Scene } from './Scene'
import type { UserSettings, VisualState } from '../../audio/types'

/**
 * ParticleFieldScene (spec §16 Scene 2 — PARTICLE FIELD)
 *
 * Visual concept:
 *   * thousands of procedural particles
 *   * particles orbit or drift
 *   * audio causes bursts and waves
 *   * particles react to bass and treble
 *
 * Mappings:
 *   bass → particle displacement (radial outward push)
 *   beat → particle burst (shockwave of brightness)
 *   treble → particle brightness
 *   energy → turbulence
 *
 * Implementation: pure GPU particle system using THREE.Points + a
 * custom ShaderMaterial. Each particle has a base position, a per-
 * particle phase, a base radius, and a speed. The vertex shader
 * animates positions every frame using a curl-noise-like flow field
 * driven by audio features + a beat-driven radial shockwave.
 *
 * No CPU work per frame except uniform updates. No textures — soft
 * round particles are drawn procedurally in the fragment shader.
 */

const PARTICLE_COUNT = 8000

// ============================================================
// VERTEX SHADER — 8000 GPU particles in a curl-noise flow field
// --------------------------------------------------------------
// Each particle's position is computed ENTIRELY on the GPU from 3
// attributes (base, seed, size). No CPU work per frame except
// uniform uploads — even at 8000 particles the JS side is idle
// between frames.
//
// Motion model: each particle wanders through a curl-noise flow
// field (a divergence-free vector field that gives smooth, swirly
// motion). Bass pushes particles radially outward; beat gives a
// shockwave impulse; mid rotates the whole field around Y.
// ============================================================
const VERT = /* glsl */ `
  // ============================================================
  // PARTICLE ATTRIBUTES (uploaded once at init)
  // ============================================================
  // SHADER ATTRIBUTE: a_base
  // Purpose: base position on a sphere shell (radius ~1.2..2.6)
  // Safe to modify: YES (via re-upload of the bases attribute buffer)
  attribute vec3  a_base;     // base position in a sphere shell

  // SHADER ATTRIBUTE: a_seed
  // Purpose: per-particle random 0..1; used to displace each
  //          particle's entry point into the curl-noise field so
  //          they don't all follow the same trajectory
  // Safe to modify: YES
  attribute float a_seed;     // per-particle random 0..1

  // SHADER ATTRIBUTE: a_size
  // Purpose: base point size (1.5..4.5); multiplied by treble +
  //          particleAmount to get the final gl_PointSize
  // Safe to modify: YES
  attribute float a_size;     // base point size

  // ============================================================
  // PARTICLE UNIFORMS (updated per frame)
  // ============================================================

  // SHADER UNIFORM: u_time
  // Purpose: master clock (seconds) from AudioEngine.currentTime
  // Safe to modify: YES
  uniform float u_time;

  // SHADER UNIFORM: u_bass
  // Purpose: low-frequency energy → radial outward push from Y axis
  // Normal range: 0..1
  // Increased: particles fly outward from the central axis
  // Decreased: tighter particle cloud
  // Safe to modify: YES
  uniform float u_bass;

  // SHADER UNIFORM: u_mid
  // Purpose: mid-frequency energy → orbit rotation around Y
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_mid;

  // SHADER UNIFORM: u_treble
  // Purpose: high-frequency energy → particle size + brightness sparkle
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_treble;

  // SHADER UNIFORM: u_energy
  // Purpose: overall energy → flow field speed + brightness
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_energy;

  // SHADER UNIFORM: u_beat
  // Purpose: short-lived beat pulse → shockwave impulse (outward kick)
  // Normal range: 0..1 (decaying)
  // Safe to modify: YES
  uniform float u_beat;

  // SHADER UNIFORM: u_motion
  // Purpose: global motion speed multiplier (flow field speed)
  // Normal range: 0..3
  // Safe to modify: YES
  uniform float u_motion;

  // SHADER UNIFORM: u_particles
  // Purpose: particle-size multiplier (particleAmount)
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_particles;

  // SHADER UNIFORM: u_distortion
  // Purpose: flow field drift amplitude (how far particles wander)
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_distortion;

  // SHADER UNIFORM: u_resolution
  // Purpose: drawing-buffer size (unused in this VS but required
  //          for symmetry with other scenes — kept for future use)
  // Safe to modify: YES
  uniform vec2  u_resolution;

  // varyings: per-particle brightness + distance (set in VS, read in FS)
  varying float v_brightness;
  varying float v_distance;

  // ============================================================
  // SECTION 1 — NOISE PRIMITIVES (3D value noise + curl)
  // ============================================================
  // --- cheap hash + value noise (vec3) -------------------------------
  vec3 hash3(vec3 p) {
    p = vec3(
      dot(p, vec3(127.1, 311.7, 74.7)),
      dot(p, vec3(269.5, 183.3, 246.1)),
      dot(p, vec3(113.5, 271.9, 124.6))
    );
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  // 3D value noise via trilinear hashing — cheap and good enough for
  // flow-field motion. Returns -1..1.
  //
  // HOW: at each of the 8 cube corners, hash a gradient direction,
  //   dot-product with the offset from corner to sample point, then
  //   trilinearly interpolate (smoothstep-faded) the 8 corner values.
  //   Standard "Perlin-style value noise" approach.
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    // smoothstep fade
    vec3 u = f * f * (3.0 - 2.0 * f);
    float n000 = dot(hash3(i + vec3(0,0,0)), normalize(f - vec3(0,0,0)));
    float n100 = dot(hash3(i + vec3(1,0,0)), normalize(f - vec3(1,0,0)));
    float n010 = dot(hash3(i + vec3(0,1,0)), normalize(f - vec3(0,1,0)));
    float n110 = dot(hash3(i + vec3(1,1,0)), normalize(f - vec3(1,1,0)));
    float n001 = dot(hash3(i + vec3(0,0,1)), normalize(f - vec3(0,0,1)));
    float n101 = dot(hash3(i + vec3(1,0,1)), normalize(f - vec3(1,0,1)));
    float n011 = dot(hash3(i + vec3(0,1,1)), normalize(f - vec3(0,1,1)));
    float n111 = dot(hash3(i + vec3(1,1,1)), normalize(f - vec3(1,1,1)));
    float nx00 = mix(n000, n100, u.x);
    float nx10 = mix(n010, n110, u.x);
    float nx01 = mix(n001, n101, u.x);
    float nx11 = mix(n011, n111, u.x);
    float nxy0 = mix(nx00, nx10, u.y);
    float nxy1 = mix(nx01, nx11, u.y);
    return mix(nxy0, nxy1, u.z);
  }

  // ============================================================
  // SECTION 2 — CURL NOISE (divergence-free flow field)
  // --------------------------------------------------------------
  // Curl noise = curl of a vector potential = cross-product of
  // gradients. The result is a divergence-free vector field, which
  // means particles flowing through it don't bunch up or spread out
  // — they form smooth, swirly, fluid-like motion.
  //
  // Mathematical curl: curl(F) = (dFz/dy - dFy/dz, dFx/dz - dFz/dx,
  //                                dFy/dx - dFx/dy)
  //
  // Here we approximate the curl via finite differences of vnoise
  // (4 noise evals — 6 would be exact but 4 is visually fine).
  // Returns a 3D direction that drives the flow field.
  //
  // Reference: Bridson et al., "Curl-Noise for Procedural Fluid
  //   Flow" (2007). Standard GPU particle technique.
  // ============================================================
  // Approximate curl via finite differences of vnoise. Returns a 3D
  // direction that drives the flow field. Cheap: 4 noise evals.
  vec3 curlNoise(vec3 p) {
    const float e = 0.1;
    float n1 = vnoise(p + vec3(e, 0.0, 0.0));
    float n2 = vnoise(p - vec3(e, 0.0, 0.0));
    float n3 = vnoise(p + vec3(0.0, e, 0.0));
    float n4 = vnoise(p - vec3(0.0, e, 0.0));
    float n5 = vnoise(p + vec3(0.0, 0.0, e));
    float n6 = vnoise(p - vec3(0.0, 0.0, e));
    // curl = (dfz/dy - dfy/dz, dfx/dz - dfz/dx, dfy/dx - dfx/dy)
    // simplified — use noise gradient cross-products for swirly flow
    return vec3(
      n4 - n3 + n5 - n6,
      n5 - n6 + n1 - n2,
      n1 - n2 + n4 - n3
    ) * 0.5;
  }

  // ============================================================
  // SECTION 3 — MAIN: particle motion pipeline
  // --------------------------------------------------------------
  // Pipeline:
  //   1. TIME          — master clock scaled by motion + energy
  //   2. FLOW FIELD    — curl-noise displacement from base position
  //   3. ORBIT         — rotate around Y (mid-driven)
  //   4. BASS PUSH     — radial outward push from Y axis
  //   5. BEAT SHOCKWAVE — brief outward impulse from center
  //   6. PROJECT       — modelView + projection
  //   7. POINT SIZE    — perspective foreshortening + treble sparkle
  //   8. BRIGHTNESS    — varying for FS to color particles
  // ============================================================
  void main() {
    // ============================================================
    // TIME (master clock with motion + energy scaling)
    // ============================================================
    // time progresses with motion + energy driving overall speed
    float t = u_time * (0.15 + u_motion * 0.4 + u_energy * 0.5);

    // ============================================================
    // PARTICLE MOTION — flow field (curl noise)
    // --------------------------------------------------------------
    // Each particle wanders through a curl-noise flow field. The
    // base position + seed define the entry point; the flow carries
    // it around. Distortion widens the flow field amplitude.
    //
    // WHY seed: without it every particle enters the curl-noise
    //   field at the same world position offset, so all particles
    //   starting at the same sphere-shell point would follow the
    //   same trajectory. a_seed offsets the entry into the field
    //   so each particle gets a unique flow path.
    // ============================================================
    vec3 p = a_base;
    vec3 flow = curlNoise(p * 0.5 + t * 0.2 + a_seed * 8.0);
    // drift amplitude scales with distortion + bass
    float drift = (0.3 + u_distortion * 1.2 + u_bass * 0.8);
    p += flow * drift;

    // ============================================================
    // PARTICLE MOTION — orbit (rotate the whole field around Y)
    // --------------------------------------------------------------
    // mat2 cos/sin rotation applied to (x, z) — the XZ plane is the
    //   horizontal plane; rotating around Y gives the whole field
    //   a slow turn that speeds up with mid.
    // ============================================================
    // gentle orbit around the Y axis so the whole field rotates
    float rot = t * 0.2 + u_mid * 0.6;
    mat2 rm = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
    p.xz = rm * p.xz;

    // ============================================================
    // PARTICLE MOTION — bass push (radial outward from Y axis)
    // --------------------------------------------------------------
    // length(p.xz) = horizontal distance from the Y axis. We compute
    //   the radial direction (normalize(p.xz)) and push the particle
    //   outward by bassPush = bass*0.6 + beat*0.4. The 'if (radial >
    //   0.001)' guard avoids NaN at the axis (normalize(0,0) is NaN).
    // ============================================================
    // bass pushes particles radially outward from the Y axis
    float radial = length(p.xz);
    float bassPush = u_bass * 0.6 + u_beat * 0.4;
    if (radial > 0.001) {
      vec2 dir = normalize(p.xz);
      p.xz += dir * bassPush;
    }

    // ============================================================
    // PARTICLE MOTION — beat shockwave (brief outward impulse)
    // --------------------------------------------------------------
    // smoothstep(1.5, 0, distFromCenter) creates a falloff: particles
    //   near the center get a bigger shock, those far away are barely
    //   moved. The +vec3(0.001) prevents normalize(0) (NaN) for the
    //   rare case where a particle is exactly at origin.
    // ============================================================
    // beat shockwave: a brief outward impulse based on distance from
    // center, scaled by the decaying beat pulse
    float distFromCenter = length(p);
    float shock = u_beat * smoothstep(1.5, 0.0, distFromCenter) * 0.5;
    p += normalize(p + vec3(0.001)) * shock;

    // ============================================================
    // CLIP-SPACE PROJECTION (perspective camera)
    // ============================================================
    vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPos;

    // ============================================================
    // POINT SIZE (perspective foreshortening + treble sparkle)
    // --------------------------------------------------------------
    // sz = a_size * (0.6 + particles*1.8 + treble*0.8)
    //   base size scaled by user's particleAmount + audio treble.
    // 1/-mvPos.z = perspective foreshortening (distant = smaller).
    // ============================================================
    // point size: shrinks with distance, grows with treble
    float sz = a_size * (4.5 + u_particles * 3.3 + u_treble * 2.5);
    gl_PointSize = sz * (1.0 / -mvPos.z);

    // ============================================================
    // BRIGHTNESS + DISTANCE VARYINGS (read by FS)
    // --------------------------------------------------------------
    // brightness: bass/energy drive overall; treble adds sparkle;
    //   beat gives a flash on each pulse. All summed (clamped by the
    //   tonemap implicit in the FS smoothstep falloff).
    // distance: passed to FS for the primary→secondary color mix.
    // ============================================================
    // brightness: bass/energy drive overall; treble adds sparkle
    v_brightness = 0.3 + u_energy * 0.7 + u_treble * 0.4 + u_beat * 0.5;
    v_distance = distFromCenter;
  }
`

// ============================================================
// FRAGMENT SHADER — procedural particle disk (soft core + halo)
// --------------------------------------------------------------
// Same gl_PointCoord technique as OrbitScene's particle FS, but
// with a TWO-LAYER falloff (core + halo) for a more "glowing orb"
// look. Brightness comes from VS-computed varying (bass+energy+
// treble+beat combined).
// ============================================================
const FRAG = /* glsl */ `
  precision highp float;
  varying float v_brightness;
  varying float v_distance;

  // SHADER UNIFORM: u_primary
  // Purpose: primary particle color (near particles)
  // Safe to modify: YES
  uniform vec3  u_primary;

  // SHADER UNIFORM: u_secondary
  // Purpose: secondary particle color (far particles)
  // Safe to modify: YES
  uniform vec3  u_secondary;

  // SHADER UNIFORM: u_glow
  // Purpose: glow strength → brightness multiplier + additive boost
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_glow;

  // SHADER UNIFORM: u_energy
  // Purpose: overall energy → brightness (in addition to v_brightness)
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_energy;

  // SHADER UNIFORM: u_colorShift
  // Purpose: signed (-1..1) hue offset for the primary/secondary mix
  // Safe to modify: YES
  uniform float u_colorShift;

  // SHADER UNIFORM: u_opacity
  // Purpose: crossfade alpha (driven by setOpacity)
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_opacity;

  void main() {
    // ============================================================
    // SOFT DISK FALLOFF (two-layer: tight core + soft halo)
    // --------------------------------------------------------------
    // gl_PointCoord is 0..1 across the point sprite. Center → 0.5,
    // edge → 0 or 1. length(d)*2 makes 0 at center, 1 at the edge.
    //   core = smoothstep(0.4, 0, r) — tight bright center
    //   halo = smoothstep(1.0, 0, r) — soft outer glow
    //   alpha = halo*0.5 + core*0.5 — blend of both
    // Two-layer gives a more "orb" look than OrbitScene's single-layer.
    // ============================================================
    // gl_PointCoord is 0..1 across the point sprite
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    // soft disk falloff (tighter core + soft halo)
    float core = smoothstep(0.4, 0.0, r);
    float halo = smoothstep(1.0, 0.0, r);
    float alpha = halo * 0.5 + core * 0.5;
    if (alpha < 0.005) discard;

    // ============================================================
    // COLOR (distance-based primary/secondary mix + brightness/glow)
    // --------------------------------------------------------------
    // distT = distance / 3 → 0 near origin, 1 at distance=3+.
    // mix(primary, secondary, distT + colorShift) → near particles
    //   use primary, far ones use secondary. Gives depth-cued color.
    // The '(1.0 + u_glow*0.6)' post-multiply is the cheap "additive
    //   brighten" trick (see OrbitScene FS for explanation).
    // ============================================================
    // distance-based color: nearer particles use primary, farther use secondary
    // actually not. I DISABLED the primary/secondary mix because it was too distracting. Instead, just use secondary for all particles.
    float distT = clamp(v_distance / 3.0, 0.0, 1.0);
    vec3 col = u_secondary;

    // brightness + glow
    col *= v_brightness * (0.4 + u_glow * 0.9);
    col = col * (1.0 + u_glow * 0.6);

    // ============================================================
    // OUTPUT — non-premultiplied alpha + AdditiveBlending
    // --------------------------------------------------------------
    // Same convention as OrbitScene's particle FS: straight RGB out,
    // alpha modulates contribution. AdditiveBlending =
    //   blendFunc(SRC_ALPHA, ONE) → result = dst + col*alpha.
    // ============================================================
    // non-premultiplied alpha (AdditiveBlending: dst + col*alpha)
    gl_FragColor = vec4(col, alpha * u_opacity);
  }
`

/**
 * Background fullscreen shader: a soft radial gradient + drifting
 * noise. Particles composite on top additively for glow.
 */
const BG_VERT = /* glsl */ `
  // ============================================================
  // BG VERTEX SHADER — fullscreen pass-through
  // ============================================================
  // COORDINATE SYSTEM: clip space (-1..1), no matrix needed
  // ============================================================
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`
const BG_FRAG = /* glsl */ `
  // ============================================================
  // BG FRAGMENT SHADER — radial gradient + drifting noise
  // --------------------------------------------------------------
  // A non-flat background so particles composite additively over
  //   something visually rich instead of a pure solid color.
  // Pipeline:
  //   1. UNIFORMS         — minimal set (time, energy, beat, glow,
  //                          colors, opacity)
  //   2. NOISE PRIMITIVES — hash2 / vnoise (2D value noise)
  //   3. main():
  //        COORDINATE SYSTEM — center uv + aspect correction
  //        RADIAL GRADIENT    — brighter near center, fades to bg
  //        DRIFTING NOISE     — atmospheric texture
  //        BEAT GLOW          — central glow on beat
  //        COLOR MIX          — background → primary tint
  //        CROSSFADE ALPHA    — non-premultiplied output
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

  // SHADER UNIFORM: u_energy
  // Purpose: overall energy → background brightness
  // Normal range: 0..1
  // Safe to modify: YES
  uniform float u_energy;

  // SHADER UNIFORM: u_beat
  // Purpose: short-lived beat pulse → central glow expansion
  // Normal range: 0..1 (decaying)
  // Safe to modify: YES
  uniform float u_beat;

  // SHADER UNIFORM: u_glow
  // Purpose: glow strength
  // Normal range: 0..2
  // Safe to modify: YES
  uniform float u_glow;

  // SHADER UNIFORM: u_primary
  // Purpose: primary color tint (radial gradient highlight)
  // Safe to modify: YES
  uniform vec3  u_primary;

  // SHADER UNIFORM: u_secondary
  // Purpose: secondary color (beat glow tint)
  // Safe to modify: YES
  uniform vec3  u_secondary;

  // SHADER UNIFORM: u_background
  // Purpose: background base color
  // Safe to modify: YES
  uniform vec3  u_background;

  // SHADER UNIFORM: u_opacity
  // Purpose: crossfade alpha (0..1)
  // Safe to modify: YES
  uniform float u_opacity;

  // ============================================================
  // SECTION 1 — NOISE PRIMITIVES (2D value noise, shared pattern)
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

  void main() {
    // ============================================================
    // COORDINATE SYSTEM (center uv + aspect correction)
    // ============================================================
    vec2 uv = (vUv - 0.5);
    uv.x *= u_resolution.x / u_resolution.y;
    float r = length(uv);

    // ============================================================
    // RADIAL GRADIENT (brighter near center, fades to bg)
    // ============================================================
    // radial gradient: brighter near center, fades to bg
    float grad = smoothstep(1.4, 0.0, r);

    // ============================================================
    // DRIFTING NOISE (atmospheric texture)
    // --------------------------------------------------------------
    // Slow-moving vnoise gives the background subtle texture so
    //   it isn't a perfectly flat solid. 0.5 re-centers to 0..1.
    // ============================================================
    // drifting noise for atmosphere
    float n = vnoise(uv * 1.5 + u_time * 0.05) * 0.5 + 0.5;

    // ============================================================
    // BEAT GLOW (central glow expands on beat)
    // ============================================================
    // beat pulse expands the central glow
    float beatGlow = u_beat * smoothstep(1.0, 0.0, r) * 0.6;

    // ============================================================
    // COLOR MIX (background → primary tint, with secondary beat flash)
    // ============================================================
    // Particle scene uses Secondary as its only accent color.
    // Primary is intentionally ignored.

    vec3 col = mix(
      u_background,
      u_secondary * 0.15,
      grad * (0.3 + n * 0.3)
    );

    col += u_secondary * beatGlow * 0.3;

    col += u_secondary * grad * (
      0.1 + u_energy * 0.3 + u_glow * 0.2
    );

    // ============================================================
    // CROSSFADE ALPHA (non-premultiplied for NormalBlending)
    // --------------------------------------------------------------
    // WHY the BG uses NormalBlending (not Additive): the BG is the
    //   base layer particles composite over. NormalBlending here
    //   means crossfade alpha works correctly when transitioning
    //   scenes — the BG fades out cleanly to whatever's behind it
    //   (the cleared background or the outgoing scene).
    // ============================================================
    // non-premultiplied alpha
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
 * ParticleFieldScene — concrete Scene implementing spec §16 Scene 2.
 *
 * Lifecycle:
 *   init()    → builds 2 layers: a fullscreen-quad background shader
 *              (NormalBlending, gives a non-flat base) + a 8000-
 *              particle THREE.Points with AdditiveBlending (the
 *              glowing dots). Both share a PerspectiveCamera.
 *   update()  → pushes VisualState + UserSettings into BOTH materials'
 *              uniforms. The particle material gets audio/state;
 *              the BG material gets a subset (energy/beat/glow/
 *              colors) — BG doesn't need bass/mid/etc. since it just
 *              reacts to the overall feel.
 *   resize()  → updates u_resolution on BOTH materials + camera.aspect
 *              for the perspective camera.
 *   setOpacity() → writes to BOTH materials' u_opacity so the BG AND
 *              particles fade together during crossfades.
 *   render()  → one draw call (three renders both objects).
 *   dispose() → frees 2 ShaderMaterials + 2 geometries (BG quad +
 *              particle buffer). Nulls all 6 fields for GC.
 *
 * WHY sphere-shell distribution: ensures the particle cloud is
 *   volumetric (3D) — particles cover a sphere shell from r=1.2 to
 *   r=2.6 — so the camera at z=6 sees depth (near particles in
 *   front, far ones behind). A flat 2D distribution would look like
 *   a textured plane, not a "field".
 */
export class ParticleFieldScene implements Scene {
  readonly id = 'particles'
  readonly name = 'Particle Field'
  readonly description =
    'Thousands of procedural particles drifting through a curl-noise flow field with audio-reactive bursts.'

  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private particleMaterial: THREE.ShaderMaterial | null = null
  private particles: THREE.Points | null = null
  private bgMaterial: THREE.ShaderMaterial | null = null
  private bgMesh: THREE.Mesh | null = null

  /**
   * Build both layers + camera. Called once when this scene
   * becomes active. Allocates: THREE.Scene (container), a
   * PerspectiveCamera (60° FOV, z=6, looking at origin — far
   * enough to see particles up to r=2.6), the BG fullscreen-quad
   * shader (NormalBlending so crossfade alpha works), and the
   * 8000-particle THREE.Points with AdditiveBlending.
   *
   * WHY dummy `positions` attribute: the vertex shader computes
   *   positions from a_base, but three's computeBoundingSphere()
   *   reads `position` to decide culling. We seed zeros so the
   *   bounding sphere is computed (avoids NaN cull bug from the
   *   original implementation — see Task 1 in worklog.md).
   */
  init(): void {
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
    this.camera.position.set(0, 0, 6)
    this.camera.lookAt(0, 0, 0)

    // Background fullscreen gradient
    this.bgMaterial = new THREE.ShaderMaterial({
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      uniforms: {
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_time: { value: 0 },
        u_energy: { value: 0 },
        u_beat: { value: 0 },
        u_glow: { value: 1 },
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
    this.bgMesh = new THREE.Mesh(fullscreenQuadGeometry(), this.bgMaterial)
    this.bgMesh.frustumCulled = false
    this.scene.add(this.bgMesh)

    // Particles: distribute on a sphere shell for a 3D cloud
    const geo = new THREE.BufferGeometry()
    const positions = new Float32Array(PARTICLE_COUNT * 3) // dummy positions (required)
    const bases = new Float32Array(PARTICLE_COUNT * 3)
    const seeds = new Float32Array(PARTICLE_COUNT)
    const sizes = new Float32Array(PARTICLE_COUNT)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // uniform point on a sphere of radius ~1.5 + jitter
      const u = Math.random()
      const v = Math.random()
      const theta = 2 * Math.PI * u
      const phi = Math.acos(2 * v - 1)
      const r = 1.2 + Math.random() * 1.4
      const x = r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta)
      const z = r * Math.cos(phi)
      bases[i * 3] = x
      bases[i * 3 + 1] = y
      bases[i * 3 + 2] = z
      seeds[i] = Math.random()
      sizes[i] = 1.5 + Math.random() * 3.0
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('a_base', new THREE.BufferAttribute(bases, 3))
    geo.setAttribute('a_seed', new THREE.BufferAttribute(seeds, 1))
    geo.setAttribute('a_size', new THREE.BufferAttribute(sizes, 1))
    geo.computeBoundingSphere()

    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        u_time: { value: 0 },
        u_bass: { value: 0 },
        u_mid: { value: 0 },
        u_treble: { value: 0 },
        u_energy: { value: 0 },
        u_beat: { value: 0 },
        u_motion: { value: 1 },
        u_particles: { value: 0.5 },
        u_distortion: { value: 0.5 },
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_primary: { value: new THREE.Color('#ff2d95') },
        u_secondary: { value: new THREE.Color('#2d9bff') },
        u_glow: { value: 1 },
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
   * Per-frame uniform push to BOTH materials. Same VisualState →
   * uniform renames (state.pulse → u_beat, state.glow → u_glow).
   * The BG gets a minimal subset; the particle material gets the
   * full set including u_distortion (flow field amplitude).
   */
  update(state: VisualState, settings: UserSettings, time: number): void {

  if (this.particleMaterial) {
    const u = this.particleMaterial.uniforms
    u.u_time.value = time
    u.u_bass.value = state.bass
    u.u_mid.value = state.mid
    u.u_treble.value = state.treble
    u.u_energy.value = state.energy
    u.u_beat.value = state.pulse
    u.u_motion.value = settings.motion
    u.u_particles.value = state.particles
    u.u_distortion.value = state.distortion
    // Primary color is disabled for ParticleField particles.
    // u.u_primary.value.copy(settings.primaryColor)
    u.u_secondary.value.copy(settings.secondaryColor)
    u.u_glow.value = state.glow
    u.u_colorShift.value = state.colorShift
  }
  
  if (this.bgMaterial) {
    const u = this.bgMaterial.uniforms
    u.u_time.value = time
    u.u_energy.value = state.energy
    u.u_beat.value = state.pulse
    u.u_glow.value = state.glow
    // Background still uses the global primary color.
    u.u_primary.value.copy(settings.primaryColor)
    u.u_secondary.value.copy(settings.secondaryColor)
    u.u_background.value.copy(settings.backgroundColor)
  }

}


  /**
   * Set crossfade opacity on BOTH materials so BG + particles fade
   * together. Forgetting one would leave particles lingering over
   * a fading background (visible artifact).
   */
  setOpacity(o: number): void {
    if (this.particleMaterial) this.particleMaterial.uniforms.u_opacity.value = o
    if (this.bgMaterial) this.bgMaterial.uniforms.u_opacity.value = o
  }

  /**
   * Viewport resize. Updates u_resolution on BOTH materials (BG
   * needs it for aspect correction; particle VS has it for symmetry
   * but doesn't actually use it). Camera aspect + projection update
   * is needed for the particle layer to render with correct perspective.
   *
   * WARNING: must update camera.aspect BEFORE updateProjectionMatrix.
   */
  resize(width: number, height: number): void {
    if (this.particleMaterial) {
      this.particleMaterial.uniforms.u_resolution.value.set(width, height)
    }
    if (this.bgMaterial) {
      this.bgMaterial.uniforms.u_resolution.value.set(width, height)
    }
    if (this.camera) {
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
    }
  }

  /**
   * Issue one draw call. Three's render loop draws both the BG mesh
   * and the THREE.Points in this scene in a single batch. VisualEngine
   * clears the framebuffer to backgroundColor before calling this.
   */
  render(renderer: THREE.WebGLRenderer): void {
    if (this.scene && this.camera) {
      renderer.render(this.scene, this.camera)
    }
  }

  /**
   * Free GPU resources. Disposes 2 ShaderMaterials (particle + BG)
   * + 2 geometries (particle buffer + BG fullscreen quad). Nulls
   * all 6 fields for GC. Called by SceneManager after crossfade-out.
   */
  dispose(): void {
    this.particleMaterial?.dispose()
    this.bgMaterial?.dispose()
    this.particles?.geometry.dispose()
    this.bgMesh?.geometry.dispose()
    this.scene = null
    this.camera = null
    this.particles = null
    this.bgMesh = null
    this.particleMaterial = null
    this.bgMaterial = null
  }
}
