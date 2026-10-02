'use client'

import { useEffect, useState } from 'react'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  FileAudio,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import { useEngines } from '@/lib/soniccanvas/ui/EngineContext'
import { formatTime } from './time'
import { WaveformDisplay } from './WaveformDisplay'
import { TrackWaveform } from './TrackWaveform'

/**
 * PlayerBar (spec §25)
 *
 * Audio player with play/pause, seek, current time, duration, volume.
 * Audio and visual timeline stay synchronized because the visual time
 * is derived from audio playback position (master clock, spec §26).
 *
 * The seek bar is a full-song waveform timeline (TrackWaveform) that
 * supports click-to-seek and shows the played/unplayed portion with a
 * gradient. A live waveform + spectrum mini-display sits next to it.
 */
export function PlayerBar() {
  const player = useSonicStore((s) => s.player)
  const track = useSonicStore((s) => s.track)
  const isExporting = useSonicStore((s) => s.isExporting)
  const { play, pause, seek, setVolume } = useEngines()

  // requestAnimationFrame tick so the time display updates without
  // forcing React re-renders from the audio engine subscription (which
  // only fires on play/pause/seek)
  const [, force] = useState(0)
  useEffect(() => {
    let raf = 0
    const loop = () => {
      force((n) => (n + 1) % 1024)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const currentTime = player.currentTime
  const duration = player.duration || track?.duration || 0

  const togglePlay = () => {
    if (player.isPlaying) pause()
    else void play()
  }

  const onVolume = (arr: number[]) => setVolume(arr[0])

  const muted = player.volume <= 0.001

  return (
    <div className="border-t border-white/10 bg-black/70 px-3 py-2.5 backdrop-blur-md">
      <div className="flex items-center gap-3">
        {/* Transport */}
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 text-white/70 hover:text-white"
            onClick={() => void seek(0)}
            disabled={!track || isExporting}
            aria-label="Restart"
          >
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            onClick={togglePlay}
            disabled={!track || isExporting}
            className={`h-11 w-11 rounded-full bg-gradient-to-br from-[#ff2d95] to-[#2d9bff] text-white shadow-lg shadow-[#ff2d95]/30 transition-all hover:scale-105 hover:brightness-110 active:scale-95 ${
              player.isPlaying ? 'animate-sonic-play-pulse' : ''
            }`}
            aria-label={player.isPlaying ? 'Pause' : 'Play'}
          >
            {player.isPlaying ? (
              <Pause className="h-5 w-5" />
            ) : (
              <Play className="h-5 w-5 translate-x-[1px]" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 text-white/70 hover:text-white"
            onClick={() => void seek(duration)}
            disabled={!track || isExporting}
            aria-label="Skip to end"
          >
            <SkipForward className="h-4 w-4" />
          </Button>
        </div>

        {/* Time + track-waveform seek (spec §46 — waveform timeline) */}
        <div className="flex flex-1 items-center gap-3">
          <span className="w-12 shrink-0 text-right font-mono text-[11px] text-white/60">
            {formatTime(currentTime)}
          </span>
          {track ? (
            <TrackWaveform />
          ) : (
            <div className="h-10 flex-1 rounded-md border border-white/5 bg-black/40" />
          )}
          <span className="w-12 shrink-0 font-mono text-[11px] text-white/60">
            {formatTime(duration)}
          </span>
        </div>

        {/* Live waveform + spectrum mini-visualization (spec §46) */}
        <WaveformDisplay width={160} height={36} />

        {/* Volume */}
        <div className="hidden items-center gap-2 sm:flex">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-white/70 hover:text-white"
            onClick={() => setVolume(muted ? 1 : 0)}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <Slider
            value={[player.volume]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={onVolume}
            aria-label="Volume"
            className="w-20"
          />
        </div>

        {/* Track info */}
        {track && (
          <div className="hidden min-w-0 max-w-[180px] items-center gap-2 rounded-md border border-white/10 bg-black/30 px-2 py-1 md:flex">
            <FileAudio className="h-4 w-4 shrink-0 text-[#2d9bff]" />
            <div className="min-w-0 truncate text-xs text-white/70">
              {track.fileName}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
