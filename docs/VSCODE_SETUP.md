# SonicCanvas — VSCode Project Setup Guide

> Complete manual for recreating the SonicCanvas project from scratch
> in Visual Studio Code.

---

## Prerequisites

Install these before starting:

1. **Node.js** 18+ (or Bun runtime)
2. **VSCode** with these extensions:
   - ESLint (`dbaeumer.vscode-eslint`)
   - Tailwind CSS IntelliSense (`bradlc.vscode-tailwindcss`)
   - GLSL lint (`slevesque.shader`) — optional, for shader syntax highlighting
3. **Bun** (recommended) — install from https://bun.sh

---

## Step 1: Create the project

```bash
# Using Bun (recommended — faster installs)
bun create next-app soniccanvas --typescript --tailwind --eslint --app

# Using npx (fallback)
npx create-next-app@latest soniccanvas --typescript --tailwind --eslint --app
```

Choose these options:
- TypeScript: **Yes**
- Tailwind CSS: **Yes**
- ESLint: **Yes**
- App Router: **Yes**
- src/ directory: **Yes**
- Import alias: **@/***(default)

---

## Step 2: Install dependencies

```bash
cd soniccanvas

# Core dependencies
bun add three @types/three zustand sonner lucide-react

# shadcn/ui components
bunx --bun shadcn@latest init
bunx --bun shadcn@latest add button card slider label select input
bunx --bun shadcn@latest add dialog accordion badge progress tooltip
bunx --bun shadcn@latest add toast sonner switch tabs separator

# Dev dependencies (already included with create-next-app)
# tailwindcss @tailwindcss/postcss tw-animate-css
```

---

## Step 3: Folder structure

Create these directories and files:

```
soniccanvas/
├── docs/
│   ├── CUSTOMIZATION_GUIDE.md      ← the big manual (copy from this project)
│   └── VSCODE_SETUP.md             ← this file
├── prisma/
│   └── schema.prisma               ← not used in MVP but scaffold exists
├── public/
│   ├── logo.svg
│   └── robots.txt
├── src/
│   ├── app/
│   │   ├── globals.css             ← Tailwind + custom CSS (animations, scrollbar)
│   │   ├── layout.tsx              ← root layout (fonts, metadata)
│   │   └── page.tsx                ← imports SonicCanvasClient (ssr: false)
│   ├── components/
│   │   ├── ui/                     ← shadcn/ui components (auto-generated)
│   │   └── soniccanvas/
│   │       ├── SonicCanvas.tsx     ← main app shell
│   │       ├── SonicCanvasClient.tsx ← client wrapper (ssr: false)
│   │       ├── Header.tsx
│   │       ├── UploadScreen.tsx
│   │       ├── VisualCanvas.tsx
│   │       ├── ControlsPanel.tsx
│   │       ├── PlayerBar.tsx
│   │       ├── TrackWaveform.tsx
│   │       ├── WaveformDisplay.tsx
│   │       ├── MappingEditor.tsx
│   │       ├── ExportDialog.tsx
│   │       ├── SavePresetDialog.tsx
│   │       ├── SharePresetDialog.tsx
│   │       ├── DebugOverlay.tsx
│   │       ├── NowPlayingOverlay.tsx
│   │       ├── KeyboardShortcutsHelp.tsx
│   │       ├── FullscreenToggle.tsx
│   │       └── time.ts             ← formatTime helper
│   ├── hooks/
│   │   ├── use-toast.ts            ← radix toast hook
│   │   └── use-mobile.ts           ← shadcn mobile detection
│   └── lib/
│       ├── utils.ts                ← shadcn cn() helper
│       ├── db.ts                   ← Prisma client (not used in MVP)
│       └── soniccanvas/
│           ├── audio/
│           │   ├── AudioEngine.ts  ← Web Audio API: decode, play, seek, volume
│           │   ├── AudioAnalyzer.ts ← FFT, bands, smoothing, beat detection
│           │   └── types.ts        ← TypeScript interfaces
│           ├── visuals/
│           │   ├── VisualEngine.ts  ← Three.js renderer, RAF loop, FPS scaler
│           │   ├── VisualMapper.ts  ← audio→visual mapping (THE creative heart)
│           │   ├── SceneManager.ts  ← scene switching + crossfade
│           │   ├── MappingCurves.ts  ← piecewise-linear response curves
│           │   ├── AutoSceneController.ts ← energy-based scene rotation
│           │   └── scenes/
│           │       ├── Scene.ts          ← interface
│           │       ├── LiquidScene.ts    ← fullscreen plasma
│           │       ├── OrbitScene.ts     ← rings + particles
│           │       ├── TunnelScene.ts    ← polar tunnel
│           │       ├── GridScene.ts      ← perspective grid
│           │       └── ParticleFieldScene.ts ← curl-noise particles
│           ├── config/
│           │   ├── defaults.ts      ← presets, scenes, DEFAULT_SETTINGS
│           │   ├── Randomizer.ts    ← random settings generator
│           │   ├── presetStorage.ts ← localStorage save/load
│           │   └── shareUrl.ts      ← URL hash encoding
│           ├── export/
│           │   └── VideoExporter.ts ← MediaRecorder + canvas.captureStream
│           └── ui/
│               ├── store.ts        ← Zustand global state
│               └── EngineContext.ts ← React context for engines
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
└── Caddyfile                       ← gateway config (if using Caddy)
```

---

## Step 4: Key configuration files

### `src/app/globals.css`

Add these custom CSS classes after the Tailwind imports:

```css
/* Custom scrollbar */
.scroll-sonic { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
.scroll-sonic::-webkit-scrollbar { width: 8px; height: 8px; }
.scroll-sonic::-webkit-scrollbar-thumb { background-color: rgba(255,255,255,0.15); border-radius: 999px; }

/* Slider gradient */
[data-slot='slider-range'] { background: linear-gradient(90deg, #ff2d95, #2d9bff) !important; }

/* Card hover glow */
.sonic-card-hover { transition: border-color 200ms, box-shadow 200ms; }
.sonic-card-hover:hover { border-color: rgba(255,45,149,0.35); box-shadow: 0 4px 24px -8px rgba(255,45,149,0.2); }

/* Play button pulse */
@keyframes sonic-play-pulse { 0% { box-shadow: 0 0 0 0 rgba(255,45,149,0.55); } 50% { box-shadow: 0 0 0 8px rgba(255,45,149,0); } 100% { box-shadow: 0 0 0 0 rgba(255,45,149,0); } }
.animate-sonic-play-pulse { animation: sonic-play-pulse 2s ease-out infinite; }

/* Equalizer bars (for "live" badge) */
@keyframes sonic-eq-bounce { 0%,100% { transform: scaleY(0.4); } 50% { transform: scaleY(1); } }
.sonic-eq-bar { display: inline-block; width: 2px; height: 12px; margin: 0 1px; background: linear-gradient(180deg,#ff2d95,#2d9bff); border-radius: 1px; transform-origin: bottom; }
.sonic-eq-bar:nth-child(1) { animation: sonic-eq-bounce 0.9s ease-in-out infinite; }
.sonic-eq-bar:nth-child(2) { animation: sonic-eq-bounce 0.7s ease-in-out infinite 0.1s; }
.sonic-eq-bar:nth-child(3) { animation: sonic-eq-bounce 1.1s ease-in-out infinite 0.2s; }
.sonic-eq-bar:nth-child(4) { animation: sonic-eq-bounce 0.8s ease-in-out infinite 0.05s; }
```

### `src/app/page.tsx`

```typescript
import { SonicCanvasClient } from '@/components/soniccanvas/SonicCanvasClient'

export default function Home() {
  return <SonicCanvasClient />
}
```

### `src/components/soniccanvas/SonicCanvasClient.tsx`

```typescript
'use client'
import dynamic from 'next/dynamic'

const SonicCanvas = dynamic(
  () => import('./SonicCanvas').then((m) => m.SonicCanvas),
  { ssr: false, loading: () => <div className="flex min-h-screen items-center justify-center bg-[#05030d] text-white/40">Loading…</div> }
)

export function SonicCanvasClient() {
  return <SonicCanvas />
}
```

### `src/app/layout.tsx`

```typescript
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "SonicCanvas — Procedural Music Video Generator",
  description: "Upload a music file and watch a procedural visual performance react in real time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${Geist({variable:"--font-geist-sans",subsets:["latin"]}).variable} ${Geist_Mono({variable:"--font-geist-mono",subsets:["latin"]}).variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
```

---

## Step 5: Build order (recommended)

Build the project in this order (each step depends on the previous):

### Phase 1: Audio pipeline
1. `audio/types.ts` — define interfaces
2. `audio/AudioEngine.ts` — Web Audio graph
3. `audio/AudioAnalyzer.ts` — FFT + bands + smoothing + beats

### Phase 2: Visual pipeline
4. `visuals/MappingCurves.ts` — curve system
5. `visuals/VisualMapper.ts` — mapping formulas
6. `visuals/scenes/Scene.ts` — interface
7. `visuals/scenes/LiquidScene.ts` — first scene (simplest shader)
8. `visuals/SceneManager.ts` — scene management
9. `visuals/VisualEngine.ts` — Three.js + render loop

### Phase 3: Configuration
10. `config/defaults.ts` — presets + default settings
11. `ui/store.ts` — Zustand store
12. `ui/EngineContext.ts` — React context

### Phase 4: UI
13. `SonicCanvasClient.tsx` — SSR-safe wrapper
14. `SonicCanvas.tsx` — app shell + engine wiring
15. `VisualCanvas.tsx` — canvas + keyboard shortcuts
16. `UploadScreen.tsx` — drag-drop + demo tone
17. `Header.tsx` — title + export button
18. `PlayerBar.tsx` — transport controls
19. `ControlsPanel.tsx` — sliders + presets
20. `MappingEditor.tsx` — curve editor + solo mode
21. `page.tsx` — import SonicCanvasClient

### Phase 5: Additional scenes
22. `OrbitScene.tsx`
23. `TunnelScene.ts`
24. `GridScene.ts`
25. `ParticleFieldScene.ts`

### Phase 6: Export + sharing
26. `export/VideoExporter.ts`
27. `ExportDialog.tsx`
28. `config/presetStorage.ts` + `SavePresetDialog.tsx`
29. `config/shareUrl.ts` + `SharePresetDialog.tsx`
30. `config/Randomizer.ts`

### Phase 7: Polish
31. `TrackWaveform.tsx` — click-to-seek waveform
32. `WaveformDisplay.tsx` — live spectrum mini-display
33. `DebugOverlay.tsx` + `NowPlayingOverlay.tsx`
34. `KeyboardShortcutsHelp.tsx` + `FullscreenToggle.tsx`
35. `AutoSceneController.ts` — automatic scene rotation

---

## Step 6: Run the project

```bash
# Start the dev server
bun run dev

# The app runs at http://localhost:3000
```

---

## Step 7: Key concepts to understand

Read `docs/CUSTOMIZATION_GUIDE.md` for detailed explanations of:

1. **Audio pipeline** — how MP3 becomes AudioFeatures (Section 3)
2. **Visual pipeline** — how AudioFeatures become pixels (Section 4)
3. **Audio→Visual mapping** — the formulas that connect them (Section 5)
4. **Shader system** — GLSL concepts used in each scene (Section 6)
5. **Safe parameters** — what to experiment with (Section 8)
6. **Effect cookbook** — practical recipes (Section 10)

---

## Common issues

### "Module not found" for `@/components/...`

Ensure `tsconfig.json` has:
```json
"paths": { "@/*": ["./src/*"] }
```

### Hydration mismatch with Radix UI

Use the `SonicCanvasClient.tsx` wrapper with `ssr: false` (see Step 4).

### Audio doesn't play (autoplay policy)

The browser requires a user gesture before starting AudioContext. The
`AudioEngine.play()` method calls `ctx.resume()` which works when
triggered by a click. For testing with agent-browser, use:
```bash
AGENT_BROWSER_ARGS="--autoplay-policy=no-user-gesture-required" agent-browser open http://localhost:3000/
```

### GLSL template literal issues

Never use backticks inside GLSL comment lines (they close the
template literal). Use single quotes instead:
```typescript
// Bad:  // the `vec3` type
// Good: // the vec3 type
```

### Three.js BufferGeometry NaN

If you see "Computed radius is NaN" in the console, your `position`
attribute array is the wrong size. For N particles with a 3-component
position, the array must be `new Float32Array(N * 3)`.
