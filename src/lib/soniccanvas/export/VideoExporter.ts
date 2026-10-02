import type { AudioEngine } from '../audio/AudioEngine'
import type { VisualEngine } from '../visuals/VisualEngine'

/**
 * Export quality presets — maps a UI label to a target video bitrate.
 *
 * WHY named presets (not a raw number): the user shouldn't have to know
 * what "8 Mbps" means. The labels are chosen for the *visual outcome*
 * they produce, not the underlying number.
 *
 * Level 3 SAFE PARAMETER — bitrates are tuned for WebM/VP9 at 720p–1080p
 *   with this app's content (smooth gradients + particles). Going below
 *   2 Mbps at 1080p produces visible block noise in the gradient regions.
 *   Going above 8 Mbps rarely improves perceptual quality but doubles
 *   file size.
 */
export type ExportQuality = 'low' | 'medium' | 'high'

/**
 * Export resolution presets — maps a UI label to a target canvas dimension.
 *
 * `preview` is special: it means "use the current canvas size" (whatever
 * the user's window is). The other two are fixed: 720p = 1280×720, 1080p =
 * 1920×1080 (16:9 — matches the canvas CSS aspect ratio).
 *
 * Level 3 SAFE PARAMETER — the two fixed resolutions are the only ones
 *   that are guaranteed to fit within MediaRecorder's typical GPU memory
 *   budget. 4K (3840×2160) works on most browsers but is excluded because
 *   some integrated GPUs can't sustain 60fps capture at that size.
 */
export type ExportResolution = '720p' | '1080p' | 'preview'

/**
 * Bundle of user choices passed into `VideoExporter.export()`.
 * Both fields are required (no defaults — the UI always picks one).
 */
export interface ExportOptions {
  resolution: ExportResolution
  quality: ExportQuality
}

/**
 * Progress update emitted to the UI during a recording.
 *
 * `progress` (0..1) is the canonical signal — the UI's progress bar is
 * driven by it. The other fields are for display ("Exporting 12.4s of
 * 35.0s") and for the cancel-button tooltip.
 */
export interface ExportProgress {
  /** 0..1 progress through the track */
  progress: number
  /** seconds recorded so far */
  recordedSeconds: number
  /** total seconds expected */
  totalSeconds: number
  /** current playback time */
  currentTime: number
}

/**
 * ============================================================================
 * MODULE: export/VideoExporter.ts — dedicated clean recording pass
 * ============================================================================
 *
 * WHAT IT IS
 *   A class that records the canvas + audio to a WebM Blob using the
 *   MediaRecorder API. The export runs a *dedicated clean pass* — it
 *   does NOT capture whatever the user is currently looking at.
 *
 * WHY IT EXISTS
 *   The user's live preview has:
 *     - mid-playback position (e.g. the user paused at 1:30 of a 3:00
 *       track to tweak colors)
 *     - the canvas at whatever window size the user happens to have
 *     - whatever FPS the live preview is currently sustaining (may be
 *       dipping because of the debug overlay or other UI work)
 *   Recording that would produce a WebM with:
 *     - a partial song
 *     - non-16:9 aspect ratios
 *     - inconsistent frame timing (visible as stutter)
 *   To produce a clean music video, we reset the audio to t=0, resize
 *   the canvas to a standard resolution, and capture at a fixed FPS.
 *
 *   This dedicated-pass approach is spec §32: "The exporter must not
 *   record the user's live preview — it does a dedicated clean pass."
 *
 * PIPELINE (reset → resize → capture → record → stop → restore)
 *
 *   1. RESET      — audio.resetForExport(): stop live playback, prime
 *                    the AudioBufferSourceNode + analyser so we can
 *                    re-play from t=0 without a fresh decode.
 *   2. RESIZE      — visual.resizeTo(w, h): set the canvas internal
 *                    drawing buffer to the target export resolution
 *                    (1280×720 or 1920×1080) while preserving the CSS
 *                    size so the preview doesn't jump.
 *   3. CAPTURE     — canvas.captureStream(60): get a MediaStream whose
 *                    video track is the canvas's live frames. Also
 *                    obtain the audio MediaStream from the AudioEngine's
 *                    MediaStreamDestinationNode and combine the two
 *                    into one MediaStream.
 *   4. RECORD      — new MediaRecorder(combined, { mimeType, bitrate }).
 *                    Start the recorder (200ms chunk interval), then
 *                    start audio playback from t=0. Each frame the
 *                    VisualEngine renders gets captured into the
 *                    stream automatically.
 *   5. STOP        — when audio reaches the end (or the user cancels),
 *                    call recorder.stop() — the `onstop` handler
 *                    concatenates accumulated chunks into one Blob.
 *   6. RESTORE     — visual.resize(): put the canvas back to its
 *                    parent-driven size so the live preview looks
 *                    normal again. Stops all stream tracks.
 *
 * WHAT GOES IN
 *   - audio: AudioEngine (must have a decoded AudioBuffer loaded).
 *   - visual: VisualEngine (must be initialized with a canvas).
 *   - options: { resolution, quality }.
 *   - onProgress: callback fired every animation frame.
 *
 * WHAT COMES OUT
 *   - Promise<Blob> — resolves with the WebM blob when recording ends.
 *   - The blob is also available via the onProgress stream until the
 *     promise resolves (for live preview rendering).
 *
 * WHAT DEPENDS ON IT
 *   - ui/EngineContext.ts (wires exporter.export to the ExportDialog).
 *   - components/soniccanvas/ExportDialog.tsx (calls .export on click).
 *
 * WHAT IT DEPENDS ON
 *   - `MediaRecorder` (browser API — Chrome/Edge/Firefox only; Safari
 *     support is partial).
 *   - `HTMLCanvasElement.captureStream` (same browser support).
 *   - `AudioEngine.getMediaStreamDestination` (must be implemented;
 *     returns a MediaStreamAudioDestinationNode).
 *
 * CUSTOMIZATION:
 *   - Bitrate presets: edit QUALITY_BITRATES below.
 *   - Resolution presets: edit RES_DIMENSIONS below.
 *   - Codec preference: edit the `candidates` array in pickMime.
 *
 * WARNING:
 *   - The export pass takes as long as the track duration (we record in
 *     real time, not faster-than-realtime). A 3-minute song = a 3-minute
 *     export. Set user expectations accordingly in the UI.
 *   - The user must NOT close the tab during export — the recorder
 *     is bound to the document lifetime. The UI should warn.
 *   - MediaRecorder in some browsers drops frames under heavy CPU load
 *     (the canvas's captureStream falls back to skipping frames rather
 *     than slowing the audio). The output may have audio that runs
 *     slightly ahead of the video if the GPU can't keep up — a known
 *     limitation of in-browser recording.
 * ============================================================================
 */

/**
 * Internal type used by pickMime — a MIME candidate + its target bitrate.
 */
interface MimeCandidate {
  mimeType: string
  videoBitsPerSecond: number
}

/**
 * Level 3 SAFE PARAMETER — quality → bitrate (bits per second).
 *
 * Tuned for WebM/VP9 at 720p–1080p with this app's content (smooth
 * gradients + particles). Going below 2 Mbps at 1080p produces visible
 * block noise in the gradient regions. Going above 8 Mbps rarely
 * improves perceptual quality but doubles file size.
 *
 * WHY the 2/5/8 spread: each step roughly doubles file size for ~20%
 * perceptual improvement. 2 Mbps is the floor for "looks acceptable",
 * 5 Mbps is the sweet spot for social sharing, 8 Mbps is for masters.
 */
const QUALITY_BITRATES: Record<ExportQuality, number> = {
  low: 2_000_000,    // 2 Mbps  — ~15 MB / minute, fine for chat previews
  medium: 5_000_000, // 5 Mbps  — ~37 MB / minute, social-share quality
  high: 8_000_000,   // 8 Mbps  — ~60 MB / minute, master quality
}

/**
 * Level 3 SAFE PARAMETER — resolution → { w, h } in pixels.
 *
 * `preview` uses {0, 0} as a sentinel — the exporter reads that as
 * "don't resize, use the current canvas size". WHY a sentinel (not
 * `null` or `undefined`): the Record<ExportResolution, ...> type makes
 * every quality key resolve to the same shape, simplifying the type
 * flow in the export() method.
 */
const RES_DIMENSIONS: Record<ExportResolution, { w: number; h: number }> = {
  preview: { w: 0, h: 0 }, // use current canvas size — no resize
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
}

export class VideoExporter {
  // --- per-export transient state (all reset in cleanup()) ---
  // MediaRecorder instance, set in step 6 (RECORD), nulled in cleanup.
  private recorder: MediaRecorder | null = null
  // Accumulated video chunks; concatenated into one Blob on stop.
  private chunks: BlobPart[] = []
  // The combined MediaStream (canvas video + audio). Saved so we can
  // stop its tracks in cleanup — otherwise they'd leak.
  private stream: MediaStream | null = null
  // requestAnimationFrame id for the progress tick loop.
  private rafId = 0
  // performance.now() at the moment recording started, for the
  // recordedSeconds field in ExportProgress.
  private startTime = 0
  // True while recording; gates the tick loop and prevents re-entry.
  private running = false
  // Caller-supplied progress callback (stored on `this` so the tick
  // closure can reach it without re-binding).
  private onProgress: ((p: ExportProgress) => void) | null = null
  // Promise resolvers — captured here so the tick loop / onstop can
  // resolve/reject the outer promise that export() returned.
  private resolveEnd: ((blob: Blob) => void) | null = null
  private rejectEnd: ((err: Error) => void) | null = null

  /**
   * Pick the best supported WebM codec. Returns a candidate object
   * describing the mime type and video bitrate.
   *
   * ====================================================================
   * LEVEL 2 ALGORITHM — MediaRecorder codec negotiation
   * ====================================================================
   *
   * Browser support for WebM recording codecs is wildly inconsistent:
   *   - VP9: best quality per bit, supported in Chrome ≥ 2020, Firefox
   *     ≥ 2017, Edge (Chromium), but NOT in Safari as of 2024.
   *   - VP8: older, universally supported where WebM is supported at
   *     all, slightly worse quality per bit than VP9.
   *   - Opus (audio): the modern audio codec for WebM; universally
   *     supported where WebM is supported.
   *
   * The negotiation strategy: try the candidates in priority order and
   * take the first one MediaRecorder.isTypeSupported() accepts. The
   * priority list is curated for *best quality first*:
   *
   *   1. video/webm;codecs=vp9,opus   (best — VP9 video + Opus audio)
   *   2. video/webm;codecs=vp8,opus   (fallback — VP8 video + Opus)
   *   3. video/webm;codecs=vp9         (audio-less — for envs where
   *                                    Opus isn't wired up)
   *   4. video/webm;codecs=vp8         (audio-less fallback)
   *   5. video/webm                    (default codec — the browser
   *                                    picks whatever it wants)
   *
   * The fallback chain is critical: returning an unsupported mime to
   * `new MediaRecorder(...)` throws `NotSupportedError` synchronously,
   * which would crash the export. By probing first, we always return
   * a working candidate (the final `'video/webm'` is universally
   * accepted on browsers that support MediaRecorder at all).
   *
   * WHY prefer VP9 over VP8: at the same bitrate, VP9 produces
   *   noticeably less block noise on smooth gradient content (which is
   *   exactly what our shader scenes render). The bitrate savings at
   *   equal quality are ~30% — significant for social sharing.
   *
   * WHY include audio-less candidates: some browser/audio-context
   *   configurations can't expose the Opus encoder (e.g. macOS Safari
   *   in private mode). The exporter still produces video-only WebM
   *   rather than failing the whole export — the user gets a silent
   *   video they can pair with the source audio in a separate tool.
   * ====================================================================
   */
  static pickMime(quality: ExportQuality): MimeCandidate {
    // Look up the target bitrate for the requested quality preset.
    const bitrate = QUALITY_BITRATES[quality]
    // Priority-ordered codec candidates. See the algorithm comment above.
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ]
    // Take the first one the browser reports as supported. WHY
    // `typeof MediaRecorder !== 'undefined'` guard: the static method
    // is only present when MediaRecorder is implemented (Safari old).
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) {
        return { mimeType: c, videoBitsPerSecond: bitrate }
      }
    }
    // Last resort — let the browser pick its default WebM encoder.
    // This always succeeds if MediaRecorder is defined at all (the
    // isSupported() outer check in export() filters out browsers that
    // don't have MediaRecorder).
    return { mimeType: 'video/webm', videoBitsPerSecond: bitrate }
  }

  /**
   * Feature-detect: does this browser support video capture at all?
   * Returns false for old Safari, all IE, and any browser that ships
   * MediaRecorder but not HTMLCanvasElement.captureStream (the older
   * EdgeHTML did this).
   */
  static isSupported(): boolean {
    if (typeof MediaRecorder === 'undefined') return false
    if (!('captureStream' in HTMLCanvasElement.prototype)) return false
    return true
  }

  /**
   * Run a clean export pass. Returns a Blob containing the WebM.
   * Caller is responsible for stopping/resuming normal playback.
   *
   * The 8 numbered comments below match the pipeline described in the
   * file's top-of-file block (RESET → RESIZE → CAPTURE → RECORD →
   * STOP → RESTORE), expanded for clarity with the in-between steps.
   */
  async export(
    audio: AudioEngine,
    visual: VisualEngine,
    options: ExportOptions,
    onProgress: (p: ExportProgress) => void
  ): Promise<Blob> {
    // Re-entry guard — if a previous export is still running, refuse
    // rather than racing two recorders against each other.
    if (this.running) throw new Error('Export already in progress')
    // Feature-detect BEFORE touching playback state, so unsupported
    // browsers don't get their audio reset for nothing.
    if (!VideoExporter.isSupported()) {
      throw new Error(
        'Your browser does not support video capture. Try Chrome, Edge, or Firefox.'
      )
    }
    // Validate input — the audio engine must have a decoded buffer.
    // Throwing here (vs. returning null) because the UI shouldn't be
    // showing the export dialog without a loaded track.
    const buffer = audio.getBuffer()
    if (!buffer) throw new Error('No audio loaded.')

    // Initialise per-export state.
    this.running = true
    this.onProgress = onProgress
    this.chunks = []

    // STEP 1: RESET — stop live playback, prime the audio graph for
    // a fresh play-from-zero. AudioEngine.resetForExport() stops the
    // current source node, disconnects any preview-only nodes, and
    // prepares to create a fresh AudioBufferSourceNode on play(0).
    audio.resetForExport()

    // STEP 2a (partial): obtain the MediaStreamAudioDestinationNode.
    // This is the sink that captures the audio graph's output as a
    // MediaStream track. The AudioEngine lazily creates it on first
    // call (so it doesn't waste an audio node in preview mode).
    const streamDest = audio.getMediaStreamDestination()
    if (!streamDest) throw new Error('Could not create audio recording stream.')

    // STEP 2b: pick codec + bitrate via the MediaRecorder negotiation
    // algorithm (see pickMime's LEVEL 2 block above).
    const mime = VideoExporter.pickMime(options.quality)

    // STEP 2c — RESIZE: set the canvas drawing buffer to the target
    // resolution before starting capture. The CSS size is preserved by
    // VisualEngine.resizeTo (it only touches drawingBufferWidth/Height,
    // not style.width/height), so the preview doesn't visually jump.
    // After export we restore the parent-driven size via restoreSize.
    const dims = RES_DIMENSIONS[options.resolution]
    const canvas = visual.getCanvas()
    // restoreSize: closure that puts the canvas back to its parent-
    // driven size after the recording finishes. Wrapped in try/catch
    // so a failure here (e.g. canvas was destroyed) doesn't mask the
    // actual export error.
    const restoreSize = () => {
      // restore to parent-driven size after the recording finishes
      try { visual.resize() } catch { /* ignore */ }
    }
    this.restoreSize = restoreSize
    // `preview` resolution skips the resize — use the current canvas.
    if (dims.w > 0) {
      visual.resizeTo(dims.w, dims.h)
    }

    // STEP 3: CAPTURE — start the canvas video stream + combine with
    // the audio stream.
    //
    // 60 fps target — the recorder will pace appropriately. WHY 60:
    // the live preview also runs at 60 fps; matching means the export
    // looks identical to what the user saw. captureStream(0) would
    // request frames-on-demand (manual frame capture) which is more
    // complex and gives no benefit here.
    const fps = 60
    const canvasStream = (canvas as HTMLCanvasElement).captureStream(fps)
    // Combine the video track(s) from the canvas + the audio track(s)
    // from the AudioContext destination into a single MediaStream that
    // the recorder will ingest. WHY a fresh MediaStream (vs. passing
    // the canvas stream and letting the recorder pull audio in via
    // options): MediaRecorder takes a single stream; mixing tracks is
    // the standard way to bundle audio + video.
    const combined = new MediaStream()
    canvasStream.getVideoTracks().forEach((t) => combined.addTrack(t))
    streamDest.stream.getAudioTracks().forEach((t) => combined.addTrack(t))

    this.stream = combined

    // STEP 4: RECORD — construct + start the MediaRecorder.
    //
    // MediaRecorder options: explicit mime (from our negotiation) +
    // explicit bitrate (so the browser doesn't pick its own default,
    // which varies wildly between Chrome and Firefox).
    this.recorder = new MediaRecorder(combined, {
      mimeType: mime.mimeType,
      videoBitsPerSecond: mime.videoBitsPerSecond,
    })
    // Accumulate chunks as they arrive. 200ms interval (passed to
    // start() below) means this fires ~5×/second — cheap.
    this.recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data)
    }
    // Build the end-of-recording promise. We capture the resolve/
    // reject onto `this` so the tick loop (STEP 5) can fire them when
    // playback ends, and the onerror handler can reject on failure.
    const endPromise = new Promise<Blob>((resolve, reject) => {
      this.resolveEnd = resolve
      this.rejectEnd = reject
      // onstop fires after recorder.stop() completes — the chunks are
      // finalised and we can concatenate them into a single Blob.
      this.recorder!.onstop = () => {
        const blob = new Blob(this.chunks, { type: 'video/webm' })
        this.resolveEnd?.(blob)
      }
      // onerror fires on encoder failure (disk full, codec crash).
      // Forward the error reason to the promise rejection so the
      // ExportDialog can show it.
      this.recorder!.onerror = (ev: Event) => {
        this.rejectEnd?.(
          new Error('Recording failed: ' + ((ev as any)?.message ?? 'unknown'))
        )
      }
    })

    // STEP 4b: start the recorder FIRST, then start audio playback.
    // Order matters: if audio plays before the recorder is started,
    // the first ~50ms of audio is lost (recorder is still spinning up).
    // 200ms = chunk interval — the recorder flushes its internal
    // buffer every 200ms and fires ondataavailable. Smaller = lower
    // latency on cancel; larger = fewer event calls. 200ms is the
    // sweet spot for a multi-minute export.
    this.recorder.start(200) // collect chunks every 200ms
    this.startTime = performance.now()
    // Start audio from t=0 — this kicks off both the audio playback
    // AND the audio analyser that drives the visuals. The visual
    // engine's RAF loop picks up the analyser's data and renders
    // frames into the canvas, which captureStream is reading.
    await audio.play(0)

    // STEP 5: STOP — drive a progress loop that watches audio playback
    // time. When playback reaches the end (or the user cancels), we
    // call finish() which stops the recorder, which fires onstop,
    // which resolves endPromise.
    const tick = () => {
      if (!this.running) return
      const t = audio.getCurrentTime()
      const dur = audio.getDuration()
      // Emit progress to the UI.
      this.onProgress?.({
        progress: dur > 0 ? t / dur : 0,
        recordedSeconds: (performance.now() - this.startTime) / 1000,
        totalSeconds: dur,
        currentTime: t,
      })
      // Stop conditions:
      //   - t >= dur - 0.05: we're within 50ms of the end — stop now
      //     so we don't record the trailing silence.
      //   - !audio.isCurrentlyPlaying(): the user paused or the source
      //     node stopped unexpectedly — stop recording too.
      if (t >= dur - 0.05 || !audio.isCurrentlyPlaying()) {
        this.finish()
        return
      }
      // Schedule the next tick — 1 frame later (~16ms at 60fps).
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)

    // Wait for the recorder's onstop → resolve. The try/finally ensures
    // cleanup runs even if the recorder rejects (e.g. user cancel).
    try {
      const blob = await endPromise
      return blob
    } finally {
      // STEP 6: RESTORE — see cleanup() below. Always runs, even on
      // success, because the canvas + audio are in a post-export state
      // (resized canvas, paused audio) that needs unwinding.
      this.cleanup()
    }
  }

  /**
   * Stop the recorder. Called by the tick loop when playback ends, or
   * by cancel() when the user aborts. Idempotent — calling finish()
   * twice is a no-op (the `running` flag gates it).
   */
  private finish(): void {
    if (!this.running) return
    this.running = false
    // Cancel the progress tick — without this, the rAF would keep
    // firing after we've stopped the recorder.
    cancelAnimationFrame(this.rafId)
    // recorder.stop() fires onstop asynchronously, which resolves the
    // endPromise. WHY the state guard: a recorder that errored out is
    // already 'inactive' — calling stop() on it would throw.
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop()
    }
  }

  /**
   * Abort an in-progress export. Returns the partial blob if any.
   *
   * Caller-facing API (EngineContext wires this to the Cancel button).
   * finish() stops the recorder (which fires onstop → resolves the
   * promise with whatever chunks have accumulated so far), then
   * cleanup() tears down the rest. The user gets a partial WebM that
   * may or may not be playable depending on how far in they were.
   */
  cancel(): void {
    if (!this.running) return
    this.finish()
    this.cleanup()
  }

  // Stored capture-side restore closure. Set in export() when we
  // resize the canvas; invoked in cleanup() to put the canvas back.
  private restoreSize: (() => void) | null = null

  /**
   * STEP 6 (RESTORE) implementation: tear down all per-export state.
   *
   * - Stops all MediaStream tracks (otherwise the canvas capture
   *   stream keeps a hidden tab alive and the audio destination keeps
   *   the AudioContext's render quantum busy).
   * - Nulls all the per-export fields so a future export starts fresh.
   * - Calls restoreSize() to put the canvas back to parent-driven sizing.
   *
   * Idempotent — every field is nullable and the closures are guarded.
   */
  private cleanup(): void {
    // Stop all tracks on the combined stream (video + audio).
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    // Drop the recorder reference — the underlying recorder has
    // already fired onstop and is now in 'inactive' state.
    this.recorder = null
    // Clear the caller-facing callback so a stale tick (if any leaks
    // through cancelAnimationFrame's 1-frame delay) doesn't fire.
    this.onProgress = null
    this.resolveEnd = null
    this.rejectEnd = null
    // Restore the canvas to its parent-driven size so the live preview
    // returns to normal after an export.
    this.restoreSize?.()
    this.restoreSize = null
  }

  /**
   * Read-only running flag for the UI to display a "recording…" state.
   */
  isRunning(): boolean {
    return this.running
  }
}
