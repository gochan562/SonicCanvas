'use client'

import { useCallback, useRef, useState } from 'react'
import { Upload, Music, Loader2, FileAudio, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import { useEngines } from '@/lib/soniccanvas/ui/EngineContext'
import { formatTime } from './time'

/**
 * Generate a short demo tone (WAV) in the browser so users can try
 * SonicCanvas without having their own audio file. Creates a layered
 * tone with bass + mid + treble + kick drum. Probably enough variety to
 * showcase all audio→visual mappings.
 * But the music is NOT good. feel free to add your own music or generate a better one!
 * Returns a File object ready to pass to loadFile().
 */
function generateDemoTone(): File {
  const sampleRate = 44100
  const duration = 12 // seconds
  const samples = sampleRate * duration
  const bytesPerSample = 2
  const dataSize = samples * bytesPerSample
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  // WAV header
  view.setUint8(0, 'R'.charCodeAt(0))
  view.setUint8(1, 'I'.charCodeAt(0))
  view.setUint8(2, 'F'.charCodeAt(0))
  view.setUint8(3, 'F'.charCodeAt(0))
  view.setUint32(4, 36 + dataSize, true)
  view.setUint8(8, 'W'.charCodeAt(0))
  view.setUint8(9, 'A'.charCodeAt(0))
  view.setUint8(10, 'V'.charCodeAt(0))
  view.setUint8(11, 'E'.charCodeAt(0))
  view.setUint8(12, 'f'.charCodeAt(0))
  view.setUint8(13, 'm'.charCodeAt(0))
  view.setUint8(14, 't'.charCodeAt(0))
  view.setUint8(15, ' '.charCodeAt(0))
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 8 * bytesPerSample, true)
  view.setUint8(36, 'd'.charCodeAt(0))
  view.setUint8(37, 'a'.charCodeAt(0))
  view.setUint8(38, 't'.charCodeAt(0))
  view.setUint8(39, 'a'.charCodeAt(0))
  view.setUint32(40, dataSize, true)
  // generate layered tone with sections
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    // section 1 (0-3s): quiet ambient
    // section 2 (3-7s): build-up
    // section 3 (7-10s): high energy drop
    // section 4 (10-12s): outro
    let amp = 0.08
    if (t > 3 && t < 7) amp = 0.08 + (t - 3) / 4 * 0.5
    if (t > 7 && t < 10) amp = 0.6
    if (t > 10) amp = 0.08
    const beat = (t % 0.5) < 0.05 ? 1 : 0.3
    const v = amp * (
      0.4 * Math.sin(2 * Math.PI * 60 * t) +
      0.25 * Math.sin(2 * Math.PI * 440 * t) +
      0.15 * Math.sin(2 * Math.PI * 6000 * t) +
      0.5 * beat * Math.sin(2 * Math.PI * 80 * t)
    )
    const s = Math.max(-1, Math.min(1, v))
    view.setInt16(44 + i * 2, Math.round(s * 30000), true)
  }
  return new File([buf], 'soniccanvas-demo-tone.wav', { type: 'audio/wav' })
}

/**
 * UploadScreen (spec §24)
 *
 * Central upload experience. Accepts drag-and-drop or a normal file
 * chooser (accessibility §35). Shows a loading state while decoding.
 * Also offers a "Try a demo tone" button that generates a short
 * layered tone in the browser so users can explore without their
 * own audio.
 *
 * Strictly local: the file is read as an ArrayBuffer and decoded in
 * the browser (spec §6 — no backend, no upload).
 */
export function UploadScreen() {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { loadFile } = useEngines()
  const isAnalyzing = useSonicStore((s) => s.isAnalyzing)
  const error = useSonicStore((s) => s.error)
  const track = useSonicStore((s) => s.track)

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      void loadFile(files[0])
    },
    [loadFile]
  )

  const handleDemo = useCallback(() => {
    const file = generateDemoTone()
    void loadFile(file)
  }, [loadFile])

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
      className="absolute inset-0 z-20 flex items-center justify-center bg-gradient-to-br from-black/80 via-[#05030d]/85 to-[#1a0820]/80 backdrop-blur-md"
    >
      <div
        className={[
          'sonic-upload-grad relative mx-4 w-full max-w-xl overflow-hidden rounded-3xl border-2 border-dashed p-10 text-center transition-all',
          dragging
            ? 'border-[#ff2d95] bg-[#ff2d95]/10 scale-[1.02] shadow-2xl shadow-[#ff2d95]/30'
            : 'border-white/20 bg-white/[0.03] hover:border-[#ff2d95]/60 hover:shadow-xl hover:shadow-[#ff2d95]/10',
        ].join(' ')}
      >
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#ff2d95] to-[#2d9bff] shadow-xl shadow-[#ff2d95]/30 transition-transform hover:scale-110">
          {isAnalyzing ? (
            <Loader2 className="h-8 w-8 animate-spin text-white" />
          ) : (
            <Upload className="h-8 w-8 text-white" />
          )}
        </div>

        <h2 className="text-2xl font-semibold tracking-tight">
          {isAnalyzing ? 'Analyzing track…' : 'Drop your music here'}
        </h2>
        <p className="mt-1 text-sm text-white/50">
          {isAnalyzing
            ? 'Decoding audio and preparing the visual pipeline.'
            : 'MP3 · WAV · OGG - processed entirely on your device.'}
        </p>

        {track && !isAnalyzing && (
          <div className="mt-5 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-left">
            <FileAudio className="h-5 w-5 text-[#2d9bff]" />
            <div className="text-sm">
              <div className="font-medium">{track.fileName}</div>
              <div className="text-xs text-white/40">
                {track.fileType || 'audio'} · {formatTime(track.duration)}
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Button
            variant="outline"
            onClick={() => inputRef.current?.click()}
            disabled={isAnalyzing}
            className="border-white/20 bg-white/5 text-white hover:bg-white/10"
          >
            <Music className="h-4 w-4" />
            Choose File
          </Button>
          {!track && !isAnalyzing && (
            <Button
              variant="ghost"
              onClick={handleDemo}
              disabled={isAnalyzing}
              className="border border-[#a855f7]/30 bg-[#a855f7]/10 text-[#c084fc] hover:bg-[#a855f7]/20"
            >
              <Wand2 className="h-4 w-4" />
              Try a demo tone
            </Button>
          )}
          {track && !isAnalyzing && (
            <Button
              variant="ghost"
              onClick={() => useSonicStore.getState().setScreen('studio')}
              className="text-white/60 hover:text-white"
            >
              Use loaded track →
            </Button>
          )}
        </div>

        {!track && !isAnalyzing && (
          <p className="mt-4 text-[11px] text-white/30">
            No audio file? Generate a 12-second demo tone with bass, mid, treble, and kick drum — right in your browser.
          </p>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/ogg,audio/vorbis,.mp3,.wav,.ogg"
          className="sr-only"
          onChange={(e) => handleFiles(e.target.files)}
          aria-label="Choose audio file"
        />

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-300"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
