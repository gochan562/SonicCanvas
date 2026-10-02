/**
 * ============================================================================
 * MODULE: AudioEngine — Web Audio graph owner & master transport clock
 * ============================================================================
 *
 * WHAT IT IS
 *   The single source of truth for everything audio in SonicCanvas. Owns
 *   the AudioContext, decodes the user's uploaded file into an in-memory
 *   AudioBuffer, drives the transport (play / pause / seek / volume),
 *   and exposes the AnalyserNode so the AudioAnalyzer can read FFT and
 *   time-domain data every animation frame.
 *
 * WHY IT EXISTS
 *   Web Audio is a low-level *graph* API: you wire nodes together and the
 *   browser runs them. It has no built-in transport (no "play/pause/seek"),
 *   no master clock that survives a tab throttle or a MediaRecorder capture
 *   pass, and no UI state broadcaster. This class fills those gaps so the
 *   rest of the app can speak to audio in plain verbs: loadFile(), play(),
 *   pause(), seek(t), setVolume(v), getCurrentTime().
 *
 * WHAT GOES IN
 *   - File objects (MP3/WAV/OGG) from the upload screen.
 *   - Transport commands (play/pause/seek/volume) from the Zustand store.
 *
 * WHAT COMES OUT
 *   - A decoded AudioBuffer (entire track held in memory).
 *   - An AnalyserNode — read each frame by AudioAnalyzer.update().
 *   - An optional MediaStreamTrack (audio) — consumed by VideoExporter.
 *   - AudioEngineState snapshots — pushed to subscribers (UI store).
 *   - getCurrentTime() — the *master clock* (spec §26) that the
 *     VisualEngine, the AudioAnalyzer, and the VideoExporter all read to
 *     stay frame-locked with the audio.
 *
 * WHAT DEPENDS ON IT
 *   - AudioAnalyzer (reads the analyser node)
 *   - VisualEngine (reads getCurrentTime() as the master clock)
 *   - VideoExporter (borrows getMediaStreamDestination() + the buffer to
 *     drive a clean recording pass — see resetForExport())
 *   - Zustand player store (subscribes for play/pause/seek/volume state)
 *
 * WHAT IT DEPENDS ON
 *   - The browser's Web Audio API (AudioContext, AnalyserNode, GainNode,
 *     MediaStreamAudioDestinationNode, AudioBufferSourceNode).
 *   - A real user gesture before the AudioContext will start (autoplay
 *     policy, spec §33). This is why ensureContext() is lazy and play()
 *     fires ctx.resume() without awaiting it.
 *
 * THE AUDIO GRAPH (spec §8):
 *
 *     [ AudioBufferSourceNode ] ---> [ AnalyserNode ] ---> [ GainNode ] ---> destination (speakers)
 *               |
 *               \---> (only during export) MediaStreamAudioDestinationNode ---> MediaRecorder
 *
 *   The analyser is a *tap* — it reads data but does not alter the audio.
 *   The gain is the user's volume knob. The MediaStreamDestination only
 *   exists during export, so the recorder captures the exact audio the
 *   user hears (post-volume, post-analyser — but since analyser is a
 *   tap, that's identical to pre-analyser).
 *
 * DESIGN INVARIANTS (don't break these):
 *   - AudioContext is created lazily inside ensureContext(), never at
 *     module load. Creating it eagerly would burn an audio hardware handle
 *     even if the user never uploads a file, and would start suspended
 *     (autoplay policy) until the first gesture.
 *   - ctx.resume() is *always* fire-and-forget. Awaiting it from a
 *     non-gesture call site hangs the promise (see WHY below).
 *   - At most one AudioBufferSourceNode is active at a time. createSource()
 *     is called only after the previous source is stopped/disconnected.
 *   - getCurrentTime() is the *only* authoritative time source. Never
 *     cache it — recompute every frame so visuals and audio never drift.
 *
 * It knows nothing about visuals. The analyser node is exposed so
 * AudioAnalyzer can read FFT data each frame.
 * ============================================================================
 */

export interface LoadResult {
  buffer: AudioBuffer
  fileName: string
  fileType: string
  duration: number
}

type StateListener = (state: AudioEngineState) => void

export interface AudioEngineState {
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
}

const ACCEPTED_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg', 'audio/vorbis']
const ACCEPTED_EXTENSIONS = ['.mp3', '.wav', '.ogg']

export class AudioEngine {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private gain: GainNode | null = null
  private streamDest: MediaStreamAudioDestinationNode | null = null
  private startTime = 0 // ctx.currentTime when playback started
  private offset = 0 // playback offset within buffer
  private volume = 1.0
  private isPlaying = false
  private fileName = ''
  private fileType = ''
  private stateListeners = new Set<StateListener>()

  /**
   * Lazily create the AudioContext and the static graph nodes (gain,
   * analyser). The optional streamDest is created later on demand by
   * getMediaStreamDestination(). Must be called after a user gesture
   * (spec §33) — which is naturally true because the first call site
   * is loadFile(), triggered by the upload drop.
   *
   * WHY lazy: AudioContext is a scarce browser resource — creating it
   *   allocates an audio hardware endpoint and is subject to the autoplay
   *   policy (suspended until a user gesture). Creating it eagerly at
   *   module load would consume that endpoint even if the user never
   *   uploads a file. We defer until the first loadFile() call.
   *
   * Idempotent: returns the existing context on subsequent calls.
   */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext
      this.ctx = new Ctx()
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.volume
      this.analyser = this.ctx.createAnalyser()
      // ============================================================
      // PARAMETER: analyser.fftSize
      // Purpose: Size of the FFT window used to compute frequency data.
      //   Produces fftSize/2 frequency bins AND fftSize time-domain samples.
      // Safe range: 32 .. 32768 (powers of two only).
      // Typical: 2048 — yields 1024 frequency bins, enough resolution to
      //   isolate bass (20-150Hz) from low-mid (150-400Hz) at 48kHz
      //   (Hz-per-bin ~ 23Hz).
      // Try: 1024 for faster/cheaper analysis; 4096 for finer low-freq
      //   detail (costs CPU and lags transients ~85ms).
      // WARNING: Too small (e.g. 256) — bass/lowMid bins merge and beat
      //   detection fails. Too large (e.g. 8192+) — beat pulses lag behind
      //   the kick by 100-200ms and feel disconnected from the music.
      // ============================================================
      this.analyser.fftSize = 2048
      // ============================================================
      // PARAMETER: analyser.smoothingTimeConstant
      // Purpose: Built-in exponential smoothing between consecutive FFT
      //   frames inside the AnalyserNode itself. 0 = no smoothing, 1 =
      //   never change. Affects only getByteFrequencyData output, not the
      //   time-domain waveform.
      // Safe range: 0.0 .. 1.0.
      // Typical: 0.6 — gentle smoothing for stable bars.
      // Try: 0.2 for raw twitches; 0.8 for ultra-smooth rolling hills.
      // WARNING: 1.0 freezes the spectrum; 0.0 produces a strobe-like
      //   flicker that makes every visual jitter. The AudioAnalyzer also
      //   applies its own per-band smoothing on top, so the combined
      //   effect compounds — keep this moderate here.
      // CUSTOMIZATION: lower if you want snappier reaction across the
      //   board; raise if visuals feel too twitchy even after tweaking
      //   AudioAnalyzer's per-band constants.
      // ============================================================
      this.analyser.smoothingTimeConstant = 0.6
      // graph: source -> analyser -> gain -> destination
      this.analyser.connect(this.gain)
      this.gain.connect(this.ctx.destination)
    }
    return this.ctx
  }

  /**
   * Validate file type before attempting decode (spec §33).
   */
  isSupportedFile(file: File): boolean {
    if (file.type && ACCEPTED_TYPES.includes(file.type)) return true
    const name = file.name.toLowerCase()
    return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext))
  }

  /**
   * Load and decode an audio file entirely in the browser.
   * Uses OffscreenCanvas-free path: just read File → ArrayBuffer →
   * decodeAudioData.
   *
   * Note: we deliberately do NOT `await ctx.resume()` here. The audio
   * context may be suspended until a real user gesture (the autoplay
   * policy, spec §33). Decoding does not require a running context.
   * Resuming the context is deferred to `play()`, which is always
   * called from a user gesture (Play button) where resume is allowed.
   */
  async loadFile(file: File): Promise<LoadResult> {
    if (!this.isSupportedFile(file)) {
      throw new Error(
        'This audio format is not supported by your browser. Try MP3, WAV, or OGG.'
      )
    }
    const ctx = this.ensureContext()
    // Best-effort: nudge the context to resume, but don't block on it
    // (may be rejected until a user gesture).
    //
    // WHY fire-and-forget (.catch(() => {}) and not await):
    //   ctx.resume() returns a Promise that the browser only resolves
    //   once it confirms a user gesture has occurred. If we await it from
    //   a non-gesture call site (tests, hot reload, SSR), the promise
    //   can hang indefinitely and freeze the whole upload flow. Firing
    //   it without awaiting lets the browser resolve it asynchronously
    //   while we proceed to decode — decoding doesn't need a running
    //   context, only an existing one.
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }
    const arrayBuffer = await file.arrayBuffer()
    // WHY slice(0): some browsers detach (neuter) the underlying
    //   ArrayBuffer once decodeAudioData consumes it. If we ever re-decode
    //   (e.g. exporter wants a fresh source), the original buffer would
    //   be unreadable. slice(0) is a cheap copy — decodeAudioData gets
    //   its own buffer to neuter, the File's ArrayBuffer stays intact.
    //   decodeAudioData can take a callback or return a promise.
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
    this.buffer = buffer
    this.fileName = file.name
    this.fileType = file.type || this.guessTypeFromName(file.name)
    this.offset = 0
    this.isPlaying = false
    this.notify()
    return {
      buffer,
      fileName: this.fileName,
      fileType: this.fileType,
      duration: buffer.duration,
    }
  }

  private guessTypeFromName(name: string): string {
    const lower = name.toLowerCase()
    if (lower.endsWith('.mp3')) return 'audio/mpeg'
    if (lower.endsWith('.wav')) return 'audio/wav'
    if (lower.endsWith('.ogg')) return 'audio/ogg'
    return 'audio/*'
  }

  getBuffer(): AudioBuffer | null {
    return this.buffer
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }

  getFileName(): string {
    return this.fileName
  }

  getFileType(): string {
    return this.fileType
  }

  getDuration(): number {
    return this.buffer?.duration ?? 0
  }

  /**
   * Create a fresh AudioBufferSourceNode and start playback from the
   * given offset. The previous source must be stopped first.
   *
   * WHY we create a *new* node every play/seek instead of reusing one:
   *   AudioBufferSourceNode is single-use by spec — once started, it
   *   cannot be restarted; once stopped, it cannot be restarted either.
   *   The only way to (re)start at a new offset is to discard the old
   *   source and create a new one. This is also why we always null out
   *   this.source in play()/pause()/seek()/resetForExport() before calling
   *   createSource() — leaving a reference to a stopped source would
   *   make the 'ended' handler logic in createSource() misbehave.
   */
  private createSource(offset: number): AudioBufferSourceNode {
    if (!this.ctx || !this.buffer || !this.analyser) {
      throw new Error('Audio not loaded')
    }
    const src = this.ctx.createBufferSource()
    src.buffer = this.buffer
    src.connect(this.analyser)
    // WHY also route to streamDest if present: MediaStreamAudioDestinationNode
    //   is a *separate* sink — connecting source -> analyser -> gain ->
    //   destination does NOT also reach it. We must explicitly connect
    //   the source to it so the exporter's MediaRecorder captures audio.
    //   This branch is a no-op except during export (when getMediaStream-
    //   Destination() has been called once).
    if (this.streamDest) src.connect(this.streamDest)
    src.addEventListener('ended', () => {
      // WHY the `this.source === src` guard: AudioBufferSourceNode fires
      //   'ended' both at natural track end AND when we manually stop()/
      //   disconnect() it (pause, seek, reset). The identity check tells
      //   apart "my source ended" from "an older source that we already
      //   replaced just finished its stop() ramp". Without it, pausing
      //   then seeking would falsely register as a natural end and reset
      //   offset to 0.
      // Natural end of track
      if (this.source === src) {
        // If we reached the end, reset to 0 (within a 50ms tolerance so a
        // rounding or scheduler-tick difference doesn't fool us).
        const reachedEnd = this.getCurrentTime() >= this.getDuration() - 0.05
        this.source = null
        if (reachedEnd) {
          this.offset = 0
          this.isPlaying = false
        }
        this.notify()
      }
    })
    // WHY clamp: defensive — AudioBufferSourceNode.start throws if the
    //   offset is negative or beyond buffer.duration. The clamp ensures
    //   seek(NaN) or seek(-1) from a buggy UI doesn't crash the audio graph.
    src.start(0, Math.max(0, Math.min(offset, this.buffer.duration)))
    return src
  }

  /**
   * Start playback from the current offset (or from `offset` if given).
   * Honors AudioContext autoplay restrictions: must be called from a
   * user gesture handler. We do NOT `await ctx.resume()` — the
   * browser resolves it asynchronously after the gesture; awaiting
   * could hang in non-gesture contexts (e.g. tests).
   *
   * WHY stop the old source first: AudioBufferSourceNode is single-use.
   *   Calling .start() twice on the same node throws. Even more subtly,
   *   if the old source is still playing when we start a new one, both
   *   would mix in the graph (two simultaneous copies of the track).
   *   Always stop, disconnect, null, then create fresh.
   */
  async play(offset?: number): Promise<void> {
    if (!this.buffer) return
    const ctx = this.ensureContext()
    if (ctx.state === 'suspended') {
      // fire-and-forget; the browser will start the context once the
      // user-gesture signal propagates.
      // WHY not await (same reason as loadFile()): awaiting resume()
      //   from inside the click handler can deadlock on some browsers
      //   if the gesture hasn't fully propagated yet. Let it run async.
      ctx.resume().catch(() => {})
    }
    if (this.source) {
      this.source.stop()
      this.source.disconnect()
      this.source = null
    }
    if (offset !== undefined) this.offset = offset
    if (this.offset >= this.buffer.duration) this.offset = 0
    this.source = this.createSource(this.offset)
    this.startTime = ctx.currentTime
    this.isPlaying = true
    this.notify()
  }

  pause(): void {
    if (!this.source || !this.ctx) return
    // capture current position before stopping
    this.offset = this.getCurrentTime()
    this.source.stop()
    this.source.disconnect()
    this.source = null
    this.isPlaying = false
    this.notify()
  }

  /**
   * Seek to a new playback position. While playing, restart the source
   * at the new offset to keep audio→visual sync (spec §26).
   */
  async seek(time: number): Promise<void> {
    if (!this.buffer) return
    const clamped = Math.max(0, Math.min(time, this.buffer.duration))
    this.offset = clamped
    if (this.isPlaying) {
      await this.play(clamped)
    } else {
      this.notify()
    }
  }

  setVolume(v: number): void {
    // Clamp first; never trust the caller.
    this.volume = Math.max(0, Math.min(1, v))
    if (this.gain && this.ctx) {
      // ============================================================
      // PARAMETER: setTargetAtTime time constant (3rd arg, 0.01)
      // Purpose: Exponential time-constant for the volume ramp. The gain
      //   reaches ~99% of the target after ~5x this value (seconds).
      // Safe range: 0.001 .. 0.5.
      // Typical: 0.01 — ~50ms ramp, inaudible as a click but prevents the
      //   zipper/discontinuity noise from instant gain jumps.
      // Try: 0.05 for a softer swell on volume changes; 0.001 if you
      //   want instant cut (or for A/B testing).
      // WARNING: 0 = instant jump -> audible "zipper" artefact on rapid
      //   slider moves. >0.2 makes the volume slider feel sluggish/laggy.
      // ============================================================
      this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01)
    }
    this.notify()
  }

  getVolume(): number {
    return this.volume
  }

  isCurrentlyPlaying(): boolean {
    return this.isPlaying
  }

  /**
   * Master clock (spec §26): derive visual time from audio playback
   * position so seeking and recording stay in sync.
   *
   * ALGORITHM (Level 2) — derive, don't store:
   *
   *   We do NOT maintain a `currentTime` field that we increment. Instead
   *   we recompute every call from three stored primitives:
   *
   *     - startTime  : ctx.currentTime captured at the last play()
   *     - offset     : playback position captured at the last pause/seek
   *     - ctx.currentTime : the browser's high-resolution audio clock
   *
   *   elapsed = ctx.currentTime - startTime
   *   currentTime = min(offset + elapsed, buffer.duration)
   *
   * WHY derive (instead of store/increment):
   *   - A stored timestamp would drift from real audio if the tab was
   *     throttled (background tab, low-power mode) or if the AudioContext
   *     lagged under load. The browser's audio clock is the *ground truth*
   *     — it's exactly where the speaker is right now.
   *   - This pattern (capture offset at pause, capture startTime at play)
   *     is the canonical Web Audio transport. Every seek/pause/play just
   *     re-anchors the two primitives; the visual clock is always correct.
   *
   * This is the single clock that VisualEngine, AudioAnalyzer.update(),
   *   and VideoExporter all read. If you change this, all three consumers
   *   desync from the audio.
   */
  getCurrentTime(): number {
    if (!this.buffer) return 0
    if (this.isPlaying && this.ctx) {
      const elapsed = this.ctx.currentTime - this.startTime
      return Math.min(this.offset + elapsed, this.buffer.duration)
    }
    return this.offset
  }

  /**
   * Create (or return existing) MediaStreamAudioDestinationNode for
   * export. While this exists, the play() path also routes audio into
   * the stream so MediaRecorder can capture it (spec §31).
   *
   * WHY lazy: a MediaStreamDestination adds a small CPU overhead on
   *   every source connection (each createSource() call adds an extra
   *   connect() to the streamDest). We only create one when the
   *   VideoExporter explicitly asks for it, and once created we keep it
   *   (creating twice would orphan the first). The mere existence of
   *   this.streamDest is also the signal that play() uses to route the
   *   source to it — see createSource().
   */
  getMediaStreamDestination(): MediaStreamAudioDestinationNode | null {
    if (!this.ctx) return null
    if (!this.streamDest) {
      this.streamDest = this.ctx.createMediaStreamDestination()
    }
    return this.streamDest
  }

  /**
   * Reset playback to the start and clear any active source. Used by
   * the exporter before a clean recording pass (spec §32).
   *
   * WHY the exporter needs this: a recording pass must start from a
   *   known position (track start), with no leftover source node from
   *   the user's preview play. The exporter calls resetForExport(), then
   *   play(), then begins MediaRecorder — guaranteeing audio + video
   *   capture both start at the same transport position.
   */
  resetForExport(): void {
    if (this.source) {
      try { this.source.stop() } catch { /* ignore */ }
      this.source.disconnect()
      this.source = null
    }
    this.offset = 0
    this.isPlaying = false
  }

  /**
   * Subscribe to state changes (play/pause/seek/volume).
   * Returns an unsubscribe function.
   *
   * WHY return an unsubscribe fn (instead of an EventTarget or store):
   *   React components want to clean up on unmount. Returning the
   *   disposer directly lets callers write `useEffect(() => {
   *     const unsub = engine.subscribe(...); return unsub
   *   }, [])` without needing to track a separate unsubscribe handle.
   */
  subscribe(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private notify(): void {
    const state: AudioEngineState = {
      isPlaying: this.isPlaying,
      currentTime: this.getCurrentTime(),
      duration: this.getDuration(),
      volume: this.volume,
    }
    for (const l of this.stateListeners) l(state)
  }

  dispose(): void {
    if (this.source) {
      try { this.source.stop() } catch { /* ignore */ }
      this.source.disconnect()
      this.source = null
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {})
    }
    this.ctx = null
    this.buffer = null
    this.analyser = null
    this.gain = null
    this.streamDest = null
    this.isPlaying = false
  }
}
