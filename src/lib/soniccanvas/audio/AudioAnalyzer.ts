import type { AudioFeatures } from './types'

/**
 * ============================================================================
 * MODULE: AudioAnalyzer — converts raw FFT/waveform bytes into music features
 * ============================================================================
 *
 * WHAT IT IS
 *   The bridge between "audio playing" and "visuals reacting". Each
 *   animation frame, it pulls FFT magnitude data and time-domain samples
 *   from the AnalyserNode that AudioEngine exposed, and turns them into a
 *   flat, normalized AudioFeatures object that the VisualMapper can map
 *   onto shader uniforms.
 *
 * WHY IT EXISTS
 *   The AnalyserNode gives you raw 0..255 bytes per FFT bin and -1..1
 *   floats per waveform sample. That's not directly usable by shaders:
 *   - Bins are linearly spaced in frequency, but human hearing is
 *     logarithmic — most of the musical action is in the low end.
 *   - Bins cover 0 Hz to Nyquist (~24 kHz at 48 kHz) with no semantic
 *     grouping; we need bass/mid/treble *bands*, not 1024 individual bins.
 *   - Raw values jitter frame-to-frame; visuals made from raw data look
 *     like a strobe. We need per-feature smoothing with different time
 *     constants for different musical roles.
 *   - We need to *detect beats* — the AnalyserNode gives magnitudes, not
 *     onsets.
 *
 *   This class does all four transformations every frame.
 *
 * WHAT GOES IN
 *   - An attached AnalyserNode (from AudioEngine.getAnalyser()).
 *   - The current master time and duration (from AudioEngine).
 *
 * WHAT COMES OUT
 *   - AudioFeatures: bass/lowMid/mid/highMid/treble (0..1, smoothed),
 *     overallEnergy (0..1, smoothed), beatPulse (1.0 on beat, decays),
 *     waveform (Float32Array of 128 samples, -1..1),
 *     spectrum (Uint8Array of 128 log-spaced bins, 0..255),
 *     time/duration passthrough.
 *
 * WHAT DEPENDS ON IT
 *   - VisualMapper — reads AudioFeatures + UserSettings -> VisualState.
 *   - DebugOverlay — displays bass/mid/treble/energy/beat bars.
 *
 * WHAT IT DEPENDS ON
 *   - AnalyserNode (FFT/time-domain data source).
 *   - The browser's Uint8Array / Float32Array typed arrays.
 *
 * FREQUENCY BANDS (spec §11):
 *   Bass:      20–150 Hz    — kick drum, sub bass
 *   Low Mid:   150–400 Hz   — bass guitar body, low toms
 *   Mid:       400–2000 Hz  — vocals, snare, guitar fundamentals
 *   High Mid:  2000–6000 Hz — presence, guitar attack, keys
 *   Treble:    6000–16000+  — cymbals, hi-hats, air
 *
 *   Boundaries are derived from the audio sample rate at attach() time
 *   (computeBandBins), NOT hard-coded bin indices — so they stay correct
 *   whether the file was decoded at 44.1kHz, 48kHz, or 96kHz.
 * ============================================================================
 */

// ============================================================
// PARAMETER: BAND_RANGES (Hz boundaries per band)
// Purpose: Defines which Hz ranges count as bass / mid / treble.
//   Boundaries follow spec §11 and ISO 266 (approximate).
// Safe range: 20..20000 Hz total; per-band [lo, hi] with hi > lo.
// Typical: bass 20-150 (kick), mid 400-2000 (vocals/snare),
//   treble 6000-16000 (cymbals/air).
// Try: Widen bass to 20-200 for EDM with sub kicks; narrow treble
//   to 8000-16000 to skip harsh cymbal noise.
// WARNING: Bands must not overlap or you'll double-count energy.
//   Each band's hi should equal the next band's lo. If they overlap,
//   energy weighting no longer sums cleanly to ~1.0.
// CUSTOMIZATION: these Hz ranges are the primary knob for *what*
//   counts as "bass" vs "mid". EDM producers may want bass 20-80;
//   classical may want mid 200-3000 (vocals are lower).
// ============================================================
const BAND_RANGES = {
  bass: [20, 150],
  lowMid: [150, 400],
  mid: [400, 2000],
  highMid: [2000, 6000],
  treble: [6000, 16000],
} as const

/** Downsampled sizes for waveform/spectrum sent to shaders. */
// ============================================================
// PARAMETER: WAVEFORM_SIZE / SPECTRUM_SIZE
// Purpose: Output array lengths sent to shaders. AudioEngine's analyser
//   produces fftSize (2048) time-domain samples and fftSize/2 (1024)
//   frequency bins per frame — too much for a uniform array upload.
//   We downsample to these compact sizes before sending to GLSL.
// Safe range: 32..256 (powers of two are friendly for GLSL uniforms).
// Typical: 128 — matches typical shader uniform array sizes and gives
//   enough samples for a waveform / spectrum to look smooth.
// Try: 64 for cheaper uniforms (less data per frame); 256 for
//   ultra-detailed spectrum with fine-grain bars.
// WARNING: Must match the GLSL uniform declaration size in every
//   scene shader or the upload silently fails (uniform array bound)
//   — shaders see zeros. If you change this, audit every scene's
//   `uniform float u_waveform[N];` declaration too.
// ============================================================
const WAVEFORM_SIZE = 128
const SPECTRUM_SIZE = 128

export class AudioAnalyzer {
  private analyser: AnalyserNode | null = null
  private freqData: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  private timeData: Float32Array<ArrayBuffer> = new Float32Array(0)
  /** downsampled waveform / spectrum for shaders */
  private waveformOut: Float32Array = new Float32Array(WAVEFORM_SIZE)
  private spectrumOut: Uint8Array = new Uint8Array(SPECTRUM_SIZE)

  // per-feature smoothed values
  private bass = 0
  private lowMid = 0
  private mid = 0
  private highMid = 0
  private treble = 0
  private energy = 0

  // beat detector state
  private bassHistory: number[] = []
  // ============================================================
  // PARAMETER: historyLen (beat detector window length)
  // Purpose: Rolling window of recent bass values used to compute the
  //   mean and variance for the beat threshold. Push one value per
  //   update() call (once per frame).
  // Safe range: 20 .. 200 (in frames).
  // Typical: 43 frames ≈ 0.72s at 60fps — long enough to see ~1-2
  //   bars of context but short enough that the threshold tracks
  //   section changes (verse -> chorus) within a beat or two.
  // Try: 86 (~1.4s) for very stable thresholds (slow songs with
  //   steady BPM); 20 (~0.3s) for hyper-reactive detection (fast
  //   drum fills where each hit should fire).
  // WARNING: Too short and the mean/variance are noisy -> false
  //   triggers everywhere. Too long and the threshold lags so far
  //   behind a loud section that beats stop firing (threshold rises
  //   with the loudness and never lets up). Also: this assumes 60fps.
  //   At 120fps the window covers ~0.36s, halving the effective time.
  // ============================================================
  private readonly historyLen = 43 // ~0.7s at 60fps
  private beatPulse = 0
  private lastBeatTime = -1

  // cached bin boundaries per band
  private bandBins: { bass: [number, number]; lowMid: [number, number]; mid: [number, number]; highMid: [number, number]; treble: [number, number] } | null = null

  attach(analyser: AnalyserNode): void {
    this.analyser = analyser
    this.freqData = new Uint8Array(analyser.frequencyBinCount)
    this.timeData = new Float32Array(analyser.fftSize)
    this.computeBandBins()
  }

  isAttached(): boolean {
    return this.analyser !== null
  }

  /**
   * Compute FFT bin index ranges for each band based on the analyser's
   * Nyquist frequency. This avoids hard-coded indices that break under
   * different sample rates.
   *
   * ALGORITHM (Level 2) — sample-rate-aware band extraction:
   *
   *   The AnalyserNode returns `frequencyBinCount` = fftSize/2 bins.
   *   Each bin covers a fixed slice of the spectrum:
   *
   *       hzPerBin = (sampleRate / 2) / frequencyBinCount
   *
   *   At 48kHz with fftSize=2048: hzPerBin = 24000 / 1024 ≈ 23.4 Hz/bin.
   *   So bin 0 = 0..23Hz, bin 1 = 23..47Hz, etc.
   *
   *   To get a band's range of bins, divide the band's Hz bounds by
   *   hzPerBin and clamp to [0, frequencyBinCount]. Each band always gets
   *   at least one bin (Math.max(start+1, end)) so a very narrow band or
   *   very high sample rate doesn't produce an empty range.
   *
   *   WHY this matters: a hard-coded "bass = bins 0..6" works at 44.1kHz
   *   but maps to ~0..260Hz at 96kHz (wrong) or ~0..130Hz at 22.05kHz
   *   (also wrong). Deriving from sampleRate makes bands mean what they
   *   say regardless of source material.
   *
   *   This runs once per attach() (sample rate doesn't change mid-session)
   *   and is cached in `this.bandBins`.
   */
  private computeBandBins(): void {
    if (!this.analyser) return
    const ctx = (this.analyser.context as AudioContext)
    const sampleRate = ctx.sampleRate
    const bins = this.analyser.frequencyBinCount
    // each bin represents sampleRate/2 / bins Hz
    const hzPerBin = sampleRate / 2 / bins

    const toBins = (lo: number, hi: number): [number, number] => {
      const start = Math.max(0, Math.floor(lo / hzPerBin))
      const end = Math.min(bins, Math.ceil(hi / hzPerBin))
      return [start, Math.max(start + 1, end)]
    }

    this.bandBins = {
      bass: toBins(BAND_RANGES.bass[0], BAND_RANGES.bass[1]),
      lowMid: toBins(BAND_RANGES.lowMid[0], BAND_RANGES.lowMid[1]),
      mid: toBins(BAND_RANGES.mid[0], BAND_RANGES.mid[1]),
      highMid: toBins(BAND_RANGES.highMid[0], BAND_RANGES.highMid[1]),
      treble: toBins(BAND_RANGES.treble[0], BAND_RANGES.treble[1]),
    }
  }

  /**
   * Average energy of a frequency band, normalized to 0..1.
   * Raw FFT bytes are 0..255; divide by 255 and apply perceptual
   * scaling so quiet music still produces visible response.
   *
   * ALGORITHM (Level 2) — band aggregation + perceptual gamma:
   *
   *   1. Sum the bytes of bins [start, end).
   *   2. Divide by count -> arithmetic mean (still in 0..255).
   *   3. Divide by 255 -> normalize to 0..1.
   *   4. Apply gamma `Math.pow(avg, 0.6)` — perceptual loudness boost.
   *
   *   WHY gamma 0.6: human loudness perception is roughly logarithmic.
   *   A signal at 30% of full-scale *sounds* about half as loud, not 30%
   *   as loud. Raw 0.3 stays 0.3 — visuals barely move. pow(0.3, 0.6)
   *   ≈ 0.49 — visuals breathe. Same logic as sRGB gamma for color.
   *
   *   Visual example (input -> output, gamma=0.6):
   *     raw 0.10 -> gamma 0.25   (was dim, now visible)
   *     raw 0.30 -> gamma 0.49   (was weak, now half)
   *     raw 0.60 -> gamma 0.74   (still strong)
   *     raw 1.00 -> gamma 1.00   (unchanged — peaks unaffected)
   */
  private bandAverage(start: number, end: number): number {
    let sum = 0
    for (let i = start; i < end; i++) sum += this.freqData[i]
    const avg = sum / Math.max(1, end - start) / 255
    // ============================================================
    // PARAMETER: perceptual gamma (Math.pow exponent, 0.6)
    // Purpose: Boost quiet signals because human loudness perception is
    //   roughly logarithmic. Without this, only loud peaks drive visuals.
    // Safe range: 0.3 .. 1.0.
    // Typical: 0.6 — sRGB-like gamma; quiet music moves visuals too.
    // Try: 0.4 for hyper-sensitive (everything reacts); 1.0 for raw
    //   linear (only loud content reacts, perfect for club visuals).
    // WARNING: <0.3 over-amplifies the noise floor (silence flickers);
    //   >1.0 *inverts* the effect — compresses quiet signals so visuals
    //   barely move on anything but peaks.
    // ============================================================
    // perceptual gamma so quieter material still moves visuals
    return Math.pow(avg, 0.6)
  }

  /**
   * Smoothing helper (spec §12):
   *   smoothed = old * a + new * (1 - a)
   * Higher `a` = smoother / slower.
   *
   * ALGORITHM (Level 2) — exponential smoothing / one-pole low-pass:
   *
   *   This is the simplest possible recursive low-pass filter. Each new
   *   output is a weighted blend of the previous output and the new input.
   *   `a` is the "memory" — how much of the past we keep.
   *
   *   - a = 0.0 -> no memory, output = new input (raw, jittery)
   *   - a = 0.5 -> half old, half new (mild smoothing)
   *   - a = 0.9 -> 90% old, 10% new (very smooth, very slow)
   *
   *   Visual example with a synthetic step input 0.1 -> 0.9 -> 0.2 -> 1.0:
   *
   *     raw:                0.10 -> 0.90 -> 0.20 -> 1.00   (jittery)
   *     a=0.5 (fast):       0.10 -> 0.50 -> 0.35 -> 0.68
   *     a=0.75 (default bass):
   *                         0.10 -> 0.30 -> 0.27 -> 0.45   (smooth swell)
   *     a=0.9 (very slow):  0.10 -> 0.18 -> 0.18 -> 0.26   (lazy lag)
   *
   *   WHY a one-pole filter (and not a moving average):
   *     - O(1) memory — only one float per feature, no history buffer.
   *     - Infinite impulse response (IIR) — a single spike fades over
   *       many frames, mimicking how human perception of loudness decays.
   *     - Tunable per-feature — bass wants slow (a=0.75, kicks thump),
   *       treble wants fast (a=0.55, hi-hats need to feel snappy).
   *
   *   See update() for the per-band `a` values and why they differ.
   */
  private smooth(oldV: number, newV: number, a: number): number {
    return oldV * a + newV * (1 - a)
  }

  /**
   * Read one frame of audio data and update all features.
   * Pass the current playback time and duration from the engine so
   * features carry timing context for the shader (spec §26).
   */
  update(time: number, duration: number): AudioFeatures | null {
    if (!this.analyser) return null
    this.analyser.getByteFrequencyData(this.freqData)
    this.analyser.getFloatTimeDomainData(this.timeData)

    if (!this.bandBins) this.computeBandBins()
    const bins = this.bandBins!

    // raw band energies
    const rawBass = this.bandAverage(bins.bass[0], bins.bass[1])
    const rawLowMid = this.bandAverage(bins.lowMid[0], bins.lowMid[1])
    const rawMid = this.bandAverage(bins.mid[0], bins.mid[1])
    const rawHighMid = this.bandAverage(bins.highMid[0], bins.highMid[1])
    const rawTreble = this.bandAverage(bins.treble[0], bins.treble[1])
    // ============================================================
    // PARAMETER: rawEnergy band weights
    // Purpose: Weighted sum of all bands into overall energy. Used by
    //   scenes for brightness / scale reactions that should respond to
    //   the *whole* mix, not just one band.
    // Safe range: 0..1 each; weights sum should ~= 1.0 for normalized
    //   output (otherwise energy over/under-shoots).
    // Typical: bass 0.30, mid 0.25 (the two most perceptually salient),
    //   lowMid/highMid/treble 0.15 each.
    // Try: bass 0.50 + others scaled down for EDM (bass dominates);
    //   treble 0.40 for classical (strings + cymbals drive loudness).
    // WARNING: If weights don't sum to 1, energy is no longer on a
    //   0..1 scale — the VisualMapper's `base + audio * reaction`
    //   formula breaks (visuals over- or under-react). The downstream
    //   code assumes 0..1.
    // CUSTOMIZATION: the relative weights here control which band the
    //   *overall* energy feature tracks. If you want energy to feel
    //   bass-heavy, weight bass higher.
    // ============================================================
    const rawEnergy =
      rawBass * 0.3 + rawLowMid * 0.15 + rawMid * 0.25 + rawHighMid * 0.15 + rawTreble * 0.15

    // ───────────────────────────────────────────────────────────────
    // LEVEL 3 — per-band smoothing constants (a in [0,1]).
    //   Lower a = faster reaction (less smooth); higher a = slower (smoother).
    //
    //     bass     0.75   slow — kicks are sustained, swell nicely
    //     lowMid   0.70   slightly faster
    //     mid      0.65   vocals need to track melodies
    //     highMid  0.60   guitar attack comes and goes fast
    //     treble   0.55   fastest — hi-hats should feel snappy
    //     energy   0.80   slowest — overall loudness barely moves
    //
    // WHY ordered: lower-frequency content changes more slowly in
    //   real music (a kick rings ~100ms; a hi-hat rings ~10ms), so
    //   smoothing time constants should *decrease* with frequency.
    //   Energy is the slowest because it's a weighted sum of all bands
    //   — averaging already damps high-frequency jitter.
    //
    // CUSTOMIZATION: bump a value toward 0.9 for liquid-smooth visuals;
    //   toward 0.3 for hyper-reactive twitch visuals.
    // WARNING: a=0 on bass + a noisy low-frequency bin produces a
    //   strobe effect; a=1 freezes that band forever.
    // ───────────────────────────────────────────────────────────────
    this.bass = this.smooth(this.bass, rawBass, 0.75)
    this.lowMid = this.smooth(this.lowMid, rawLowMid, 0.7)
    this.mid = this.smooth(this.mid, rawMid, 0.65)
    this.highMid = this.smooth(this.highMid, rawHighMid, 0.6)
    this.treble = this.smooth(this.treble, rawTreble, 0.55)
    this.energy = this.smooth(this.energy, rawEnergy, 0.8)

    // ───────────────────────────────────────────────────────────────
    // ALGORITHM (Level 2): Energy-based beat detection (spec §13)
    // ───────────────────────────────────────────────────────────────
    //
    // CONCEPT
    //   A "beat" is a sudden increase in low-frequency energy above
    //   what the recent past would predict. We watch the bass band
    //   and ask: "is right now *significantly* louder than usual?"
    //
    // STEPS
    //   1. Push rawBass into a rolling window (historyLen ≈ 0.7s).
    //   2. Compute mean (avg) and variance over the window.
    //   3. threshold = avg * 1.4   <- must be 40% louder than the mean
    //              + sqrt(variance) * 1.5   <- +1.5σ (statistical surprise)
    //              + 0.05   <- absolute floor (kills noise floor)
    //   4. Fire if rawBass > threshold
    //                  AND rawBass > 0.18 (absolute loudness floor)
    //                  AND (last beat was > 0.12s ago) — refractory period
    //
    // WHY a *statistical* threshold (mean + σ) rather than a fixed number:
    //   Different songs sit at different loudness levels. A kick in a
    //   quiet jazz ballad at bass=0.25 would never cross a fixed 0.5
    //   threshold. A fixed threshold also false-triggers on sustained
    //   bass in loud club mixes. By comparing to the *local* mean and
    //   standard deviation, the threshold adapts per-track and per-section.
    //
    // WHY the refractory period (minGap = 0.12s):
    //   A real kick drum can't fire faster than ~500 BPM = 120ms apart.
    //   Without the gap, a single transient (which takes a few frames to
    //   ring out) would fire 3-4 pulses in a row, merging into one long
    //   smear instead of a single sharp pulse.
    //
    // WHY bass (and not full-band energy):
    //   Beats are *low-frequency* events — the kick and the snare's
    //   fundamental. Hi-hats and cymbals fire constantly in the treble
    //   and would produce a stream of false beats.
    // ───────────────────────────────────────────────────────────────
    this.bassHistory.push(rawBass)
    if (this.bassHistory.length > this.historyLen) this.bassHistory.shift()
    const avg =
      this.bassHistory.reduce((a, b) => a + b, 0) / this.bassHistory.length
    const variance =
      this.bassHistory.reduce((a, b) => a + (b - avg) * (b - avg), 0) /
      this.bassHistory.length
    // ============================================================
    // PARAMETER: beat threshold coefficients
    //   avg * 1.4   <- must be 40% louder than the recent mean
    //   + sqrt(var) * 1.5   <- +1.5 standard deviations of surprise
    //   + 0.05   <- absolute floor (kills silence-triggered beats)
    // Safe range:
    //   meanMult   1.1 .. 2.0   (lower = more sensitive)
    //   varMult    0.5 .. 3.0   (higher = needs more surprise)
    //   floor      0.01 .. 0.2 (higher = ignores very quiet audio)
    // Typical: 1.4 / 1.5 / 0.05 — fires on clear kicks, ignores ambience.
    // Try: 1.2 / 1.0 / 0.03 for sensitive (catches ghost notes);
    //      1.6 / 2.0 / 0.10 for strict (only big drops fire).
    // WARNING: Lower than ~1.1 meanMult + 0.5 varMult -> constant firing
    //   on any sustained bass note (every frame qualifies). Higher than
    //   ~2.0 + 3.0 -> almost nothing ever fires, even on clear kicks.
    // ============================================================
    const threshold = avg * 1.4 + Math.sqrt(variance) * 1.5 + 0.05
    // ============================================================
    // PARAMETER: rawBass absolute floor (0.18)
    // Purpose: Below this bass level we never fire — guards against
    //   beating on silence + quantization noise.
    // Safe range: 0.05 .. 0.35.
    // Typical: 0.18 — corresponds to roughly -15 dBFS bass energy.
    // Try: 0.10 if the source is very quiet (lo-fi mastered tracks);
    //   0.30 if very loud master (modern slammed masters).
    // WARNING: Too low -> noise floor triggers ghost beats; too high
    //   -> quiet tracks never detect any beats at all.
    // ============================================================
    // require some quiet time between beats so pulses don't merge
    // ============================================================
    // PARAMETER: minGap (refractory period between beats, 0.12s)
    // Purpose: Minimum seconds between two consecutive beat pulses.
    // Safe range: 0.05 .. 0.30.
    // Typical: 0.12s — corresponds to max 500 BPM, faster than any
    //   real music, but tight enough to keep rapid kicks distinct.
    // Try: 0.20s for slow songs (cleaner, separate pulses);
    //   0.08s for drum-and-bass (rapid breaks at 160+ BPM).
    // WARNING: <0.05s -> double-triggers on a single transient (a kick
    //   rings across multiple frames and re-fires); >0.30s -> fast songs
    //   miss half their kicks (a 140 BPM track has kicks every 0.43s).
    // ============================================================
    const minGap = 0.12
    if (
      rawBass > threshold &&
      rawBass > 0.18 &&
      (this.lastBeatTime < 0 || time - this.lastBeatTime > minGap)
    ) {
      this.beatPulse = 1
      this.lastBeatTime = time
    }
    // ============================================================
    // PARAMETER: beatPulse decay rate (1 / (60 * 1.2))
    // Purpose: Linear decay from 1.0 -> 0.0 over 1.2 seconds at 60fps.
    //   At each frame, pulse decreases by 1/(60*1.2) ≈ 0.0139.
    // Safe range: 1/(60*0.3) .. 1/(60*3.0)  -> 0.3s .. 3.0s decay.
    // Typical: 1.2s — long enough that a kick visibly flashes and
    //   fades, short enough that rapid kicks stay distinct.
    // Try: 0.5s for snappy, video-clip style pulses; 2.0s for ambient
    //   wash where each beat bleeds into the next.
    // WARNING: Hard-coded to a 60fps assumption. If you run at 120fps,
    //   the pulse decays twice as fast (visual beat gets shorter).
    //   To make it framerate-independent, multiply by dt instead:
    //     this.beatPulse = Math.max(0, this.beatPulse - dt / 1.2)
    //   (would require threading dt into update()).
    // ============================================================
    this.beatPulse = Math.max(0, this.beatPulse - 1 / (60 * 1.2))

    // downsample waveform (float -1..1) -> -1..1
    // WHY step stride (not interpolation): the analyser's time-domain
    //   buffer (2048 samples) is already a dense representation of one
    //   FFT window (~43ms at 48kHz). Stride-sampling every 16th sample
    //   gives a faithful shape of the waveform without spending CPU on
    //   linear interpolation — shaders consume the values directly as a
    //   1D texture / uniform array.
    const step = Math.max(1, Math.floor(this.timeData.length / WAVEFORM_SIZE))
    for (let i = 0; i < WAVEFORM_SIZE; i++) {
      this.waveformOut[i] = this.timeData[i * step] || 0
    }
    // ───────────────────────────────────────────────────────────────
    // ALGORITHM (Level 2): Log-spaced spectrum downsample
    // ───────────────────────────────────────────────────────────────
    // The raw spectrum is ~1024 bins linearly spaced 0..24kHz. The
    // shader only wants 128 values. If we just took bins 0, 8, 16, ...
    // we'd waste 90% of those 128 slots on the inaudible 12-24kHz range
    // and barely have any resolution in the musically-rich 20-500Hz
    // range where most instruments live.
    //
    // Instead we sample bin indices with a power curve: idx = t^1.6 * N.
    // At t=0.0 -> bin 0 (DC), at t=1.0 -> last bin. The exponent 1.6
    // bends the curve so the first half of the output covers the
    // lowest ~10% of bins (where the bass lives) and the upper half
    // stretches across the rest. This roughly matches the logarithmic
    // spacing of musical notes (each octave doubles in frequency).
    //
    //   t=0.0  -> idx = 0           (lowest freq)
    //   t=0.25 -> idx ≈ 0.05 * N    (still in low bass)
    //   t=0.5  -> idx ≈ 0.33 * N    (around mid)
    //   t=0.75 -> idx ≈ 0.66 * N    (high mid)
    //   t=1.0  -> idx = N-1         (top)
    // ───────────────────────────────────────────────────────────────
    const specLen = this.freqData.length
    for (let i = 0; i < SPECTRUM_SIZE; i++) {
      // log scale: more resolution at low freq
      const t = i / SPECTRUM_SIZE
      // ============================================================
      // PARAMETER: log spectrum power (1.6)
      // Purpose: Bends the spectrum-downsample curve so low frequencies
      //   get more output slots (musically richer) than high.
      // Safe range: 1.0 .. 3.0.
      // Typical: 1.6 — roughly one octave per ~10% of output length.
      // Try: 1.0 = linear (bins spread evenly); 2.5 = very log-heavy
      //   (most output is bass, treble crammed into last few slots).
      // WARNING: 1.0 makes the spectrum visually bass-starved (only
      //   1-2 slots for 20-200Hz). 3.0+ starves the treble end and the
      //   last few bins all sample the same top bin (waste + aliasing).
      // ============================================================
      const idx = Math.floor(Math.pow(t, 1.6) * specLen)
      this.spectrumOut[i] = this.freqData[Math.min(specLen - 1, idx)]
    }

    return {
      bass: this.bass,
      lowMid: this.lowMid,
      mid: this.mid,
      highMid: this.highMid,
      treble: this.treble,
      overallEnergy: this.energy,
      beatPulse: this.beatPulse,
      waveform: this.waveformOut,
      spectrum: this.spectrumOut,
      time,
      duration,
    }
  }

  /** Reset smoothing state when seeking so transients don't smear. */
  // WHY: when the user seeks, the next frame's rawBass may jump from
  //   where we left off to a totally different point in the song. If
  //   smoothing state carries over, the smoothed value will lazily lag
  //   toward the new value over ~1s — visuals will "smear" across the
  //   jump. Resetting the smoothed state and the beat detector history
  //   means the next update() starts fresh: the new section's character
  //   is captured within ~0.7s (the history window) instead of needing
  //   ~2s to flush old state.
  resetSmoothing(): void {
    this.bass = 0
    this.lowMid = 0
    this.mid = 0
    this.highMid = 0
    this.treble = 0
    this.energy = 0
    this.beatPulse = 0
    this.bassHistory = []
    this.lastBeatTime = -1
  }
}
