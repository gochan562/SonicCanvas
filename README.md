# SonicCanvas

SonicCanvas turns a music file into an animated visual that reacts while the track plays. I wanted something more interesting than one waveform that changes size, so I built several different scenes: Liquid, Orbit, Tunnel, Grid, and Particle Field. You can try a built-in demo tone before loading your own music, change the visual settings, and export the result as a WebM.

## how it works

The audio analyzer uses the browser's Web Audio API to read frequency and waveform data. It turns that data into values such as bass, treble, overall energy, and a beat pulse, which the visuals can react to. I also downsample the waveform and spectrum so they can be passed to the rendering side without sending the whole audio buffer into every visual.

The visuals are built with Three.js and custom scene code. Each scene has its own look and rendering logic instead of being the same effect with a different color. The visual engine updates the active scene with the latest audio features, and the scene manager handles switching and crossfading between scenes. Auto-scene mode can use the track's energy and beat pulse to decide when to switch.

## what took the most work

Beat detection was one of the harder parts. A change in volume is not always a beat, and a pulse that fires too often or feels late makes the whole visual look wrong. I had to work on making the audio features useful for animation, not just producing numbers from the analyzer.

The Primary Color control in Particle Field was another edge case. That scene should not react to the global Primary Color setting, so the control is disabled when Particle Field is selected. I also needed to make sure that setting does not sneak into either the live render or the exported WebM.

Exporting the animation took work too. It is one thing to make the canvas look right while the app is running; it is another to record the moving result into a video. The exporter, renderer, and current scene settings all need to stay consistent through the recording, otherwise the exported result can differ from what I was looking at.

## what i'd add next

I would focus on making beat detection behave better across different kinds of music and testing WebM export more thoroughly, especially on longer tracks and different browsers. After that, I would improve the audio-to-visual mapping controls so it is easier to get a specific result without needing to add more scenes just for the sake of having more scenes.

## run locally

You need Bun installed. From the project directory, run:

```bash
bun install
bun dev
```

Then open `http://localhost:3000` in your browser.

## built with

Next.js, React, TypeScript, Three.js, the Web Audio API, Zustand, and Tailwind CSS.

## License
Currently, none.

## Others
The comments I made in-code are not AI generated. It's there because I want beginners can also understand what each section does.
I also use `AGENTS.md` and `CLAUDE.md` to document project-specific instructions for AI coding agents. They help keep development consistent by explaining the project's structure, conventions, and important implementation details, so I don't have to re-explain everything every time I work on it. I still need to make the design decisions, check the final code, and debug things when they don't work as expected.
