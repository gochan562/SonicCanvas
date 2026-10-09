# SonicCanvas

SonicCanvas is a browser-based music visualization tool that turns audio into real-time generative visuals.

Load an audio file, choose a visual scene, adjust the parameters, and watch the visualization react to the music. The same rendering system is used for both the live preview and video export.

---

## Features

### Audio-reactive visualization

SonicCanvas analyzes audio in real time and exposes musical information such as energy and beat activity to the visual engine.

Visual parameters can respond dynamically to the audio instead of relying on pre-rendered animations.

---

### Multiple visual scenes

The visualization engine is built around independent scenes with different rendering behavior.

Current scenes include:

* Particle Field
* Orbit
* Additional scene systems under active development

Each scene has its own rendering logic and controls.

---

### Visual controls

The control panel provides adjustable parameters for the active scene, including:

* Intensity
* Motion
* Glow
* Particles
* Distortion
* Primary Color
* Secondary Color
* Background Color

Some controls are scene-specific. For example, Primary Color is intentionally disabled for the Particle scene, where Secondary Color is used as the main visual accent.

---

### Audio mapping

SonicCanvas is designed around mapping audio properties to visual parameters. This allows movement, brightness, particle behavior, and other visual properties to change with the music.

---

### Video export

The canvas can be recorded directly from the WebGL renderer and exported as a video.

The exported visualization uses the same rendering pipeline as the live preview, so scene behavior and visual settings remain consistent between preview and export.

---

## Technology

SonicCanvas is built with:

* Next.js
* React
* TypeScript
* Three.js
* Tailwind CSS
* Zustand
* Radix UI components
* Bun

The visualization layer uses Three.js and custom GLSL shaders for GPU-based rendering.

---

## Development

### Requirements

* Bun
* A modern browser with WebGL support

### Install

```bash
bun install
```

### Run locally

```bash
bun run dev
```

Then open:

```text
http://localhost:3000
```

### Type checking

```bash
bunx tsc --noEmit
```

---


## Rendering Architecture

SonicCanvas separates the visual system into a reusable rendering engine and individual scenes.

The visual engine manages the renderer, canvas, animation loop, scene lifecycle, resizing, and shared visual state.

Each scene contains its own Three.js objects, materials, shaders, uniforms, and update logic.

Audio analysis is fed into the active scene through shared state, allowing shader uniforms and scene parameters to react to the music in real time.

Video export captures the rendered canvas directly, which means the live renderer and exported video share the same visual implementation.


---

## Status

SonicCanvas is an active development project. The core visualization and export pipeline is functional, while additional scenes, controls, mappings, and rendering features continue to evolve. For further guides, please visit /docs.

---

## License

This project does not currently specify a public software license.

---

## Other

* Please note that **generative AI tools** were used to assist in drafting and organizing some part of the documentations. While the core data has been checked, please verify critical metrics independently before finalizing.
* All of the comments are written by me, and none of it is a starter template/boilerplate copy-pasted from others.(I just wanted absolute beginners can also understand the codes)
* This project is made 2 months ago, before I joined Hack Club or uploaded it to GitHub, so the initial commit carries a lot of codes and files. The Hackatime record is much less than the actual development.


Whatever, please have fun and feel free to modify / contribute to SonicCanvas!
