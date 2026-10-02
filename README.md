# SonicCanvas

**SonicCanvas is a browser-based procedural music visualizer that turns audio into a real-time visual performance.**

Upload a music file, choose a visual scene, tune how different parts of the audio influence the visuals, and watch the scene respond in real time.

The goal is to make audiovisual experimentation feel less like configuring a technical system and more like playing an instrument.


## ✨ Features

### 🎵 Audio-reactive visuals

SonicCanvas analyzes the uploaded audio in real time and extracts characteristics such as:

* Bass
* Treble
* Beat intensity
* Overall energy

These values can drive different properties of the visual scene.

### 🎨 Procedural visual scenes

Visual scenes are generated procedurally rather than relying on a pre-rendered video.

Scenes can respond continuously to the incoming audio, producing a visual performance that changes with the music.

### 🎛️ Visual controls

Tune the behavior of the visual engine with controls for:

* Intensity
* Motion
* Glow
* Particles
* Distortion

### 🧩 Audio mapping

Different audio characteristics can be mapped to visual parameters.

For example, bass can influence one property while treble, beat intensity, or overall energy influences another.

SonicCanvas also includes a mapping editor for creating more customized relationships between audio input and visual output.

### 🌈 Color system

Customize the visual palette with:

* Primary color
* Secondary color
* Background color
* Color shift

### 🎬 Scene and preset workflow

SonicCanvas includes scene selection, presets, automatic scene switching, and playback controls so a visual performance can be shaped without editing the underlying rendering code.

### 🖥️ Browser-based

The application is designed to run directly in the browser.

Audio analysis and visual rendering happen locally in the browser, allowing the core audiovisual experience to work without requiring a remote rendering service.

---

## 🧠 How it works

SonicCanvas is built around the relationship between **audio analysis and procedural graphics**.

An uploaded audio track is processed through the Web Audio API. SonicCanvas extracts useful audio signals and normalizes them into values that can drive the visual engine.

Those values are then passed through the mapping system.

Instead of saying:

> "At 1:32 in the song, play this animation."

the system can express relationships such as:

> "As bass intensity increases, increase the visual distortion."

This makes the resulting visualization responsive to the actual structure of the music.

The visual engine uses **Three.js / WebGL** to render the procedural scenes in real time.

---

## 🛠️ Tech Stack

| Technology    | Purpose                           |
| ------------- | --------------------------------- |
| Next.js       | Application framework             |
| React         | UI                                |
| TypeScript    | Application logic and type safety |
| Three.js      | Real-time 3D/WebGL rendering      |
| Web Audio API | Audio analysis and playback       |
| Zustand       | Client-side state management      |
| Tailwind CSS  | Styling                           |
| shadcn/ui     | UI components                     |
| Lucide        | Interface icons                   |
| Sonner        | Notifications                     |

---

## 🚀 Getting Started

### Requirements

* Node.js or Bun
* A modern browser with Web Audio and WebGL support

### Install

Clone the repository:

```bash
git clone https://github.com/gochan562/SonicCanvas.git
cd SonicCanvas
```

Install dependencies:

```bash
bun install
```

### Start the development server

```bash
bun run dev
```

Then open:

```text
http://localhost:3000
```

### Type-check

```bash
bunx tsc --noEmit
```

### Production build

```bash
bun run build
```

---

## 📁 Project Structure

The main application code lives under `src/`.

```text
src/
├── app/
│   ├── api/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
│
├── components/
│   ├── soniccanvas/
│   └── ui/
│
├── hooks/
│
└── lib/
    └── soniccanvas/
        ├── audio/
        ├── visuals/
        ├── config/
        ├── export/
        └── ui/
```

### `components/soniccanvas`

Contains the main SonicCanvas interface and application-level components.

Examples include:

* `SonicCanvas.tsx`
* `ControlsPanel.tsx`
* `VisualCanvas.tsx`
* `PlayerBar.tsx`
* `MappingEditor.tsx`
* `UploadScreen.tsx`

### `lib/soniccanvas`

Contains the underlying audiovisual systems rather than the interface itself.

This separation makes it possible to work on the visual engine, audio analysis, configuration, and UI independently.

---

## 🎨 Customization

SonicCanvas is intended to be experimented with.

Important customization areas include:

* visual scenes
* scene parameters
* audio analysis
* audio-to-visual mappings
* colors
* particle behavior
* motion
* distortion
* rendering behavior
* interface components

See the documentation in [`docs/`](./docs/) for more detailed information about modifying the project.

---

## 📸 Screenshots

Add screenshots or recordings of the current SonicCanvas interface here.

<!--
Example:

![SonicCanvas interface](docs/images/screenshot.png)
-->

---

## 🗺️ Roadmap

SonicCanvas is still an evolving project.

Possible future work includes:

* More procedural visual scenes
* More sophisticated audio mappings
* Expanded mapping curves and controls
* More export options
* Improved performance for complex scenes
* Better customization workflows
* More visual effects
* Improved documentation
* More accessible interaction and controls

The roadmap is intentionally flexible as the project develops.

---

## 📚 Documentation

Additional project documentation is available in [`docs/`](./docs/).

* [`CUSTOMIZATION_GUIDE.md`](./docs/CUSTOMIZATION_GUIDE.md) — customization and modification guide
* [`VSCODE_SETUP.md`](./docs/VSCODE_SETUP.md) — local development and editor setup

---

## 🤝 Contributing

SonicCanvas is currently a personal development project, but the repository is public so the code, ideas, and development process can be explored.

If you find a bug or have an idea, feel free to open an issue.

---

## 📄 License

License information will be added as the project is prepared for broader public use.

---

## About

SonicCanvas is an audiovisual experiment exploring the intersection of:

**music × computation × procedural graphics × interaction**

The project focuses on turning relationships in sound into something that can be seen, manipulated, and experimented with in real time.
