'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Keyboard, X } from 'lucide-react'

/**
 * KeyboardShortcutsHelp
 *
 * A small floating help panel that shows all keyboard shortcuts.
 * Toggled by pressing `?` (and dismissed by Escape or clicking the X).
 * Also reachable via the Help button in the bottom-right corner.
 *
 * Shortcuts (spec §25 — keyboard controls optional but nice):
 *   Space         play / pause
 *   ← / →         seek -5s / +5s
 *   ↑ / ↓         volume up / down
 *   M             mute / unmute
 *   1–5           switch scene (Liquid / Orbit / Tunnel / Grid / Particles)
 *   A             toggle auto-scene mode
 *   D             toggle debug overlay
 *   Shift+1-4     solo bass / beat / treble / energy
 *   ?             toggle this help
 *   Esc           close any open dialog / help
 */
const SHORTCUTS: { keys: string[]; label: string; group: string }[] = [
  { keys: ['Space'], label: 'Play / Pause', group: 'Playback' },
  { keys: ['←'], label: 'Seek -5s', group: 'Playback' },
  { keys: ['→'], label: 'Seek +5s', group: 'Playback' },
  { keys: ['↑'], label: 'Volume up', group: 'Playback' },
  { keys: ['↓'], label: 'Volume down', group: 'Playback' },
  { keys: ['M'], label: 'Mute / Unmute', group: 'Playback' },
  { keys: ['1'], label: 'Liquid Plasma', group: 'Scenes' },
  { keys: ['2'], label: 'Orbit', group: 'Scenes' },
  { keys: ['3'], label: 'Tunnel', group: 'Scenes' },
  { keys: ['4'], label: 'Grid', group: 'Scenes' },
  { keys: ['5'], label: 'Particle Field', group: 'Scenes' },
  { keys: ['A'], label: 'Toggle auto-scene mode', group: 'Scenes' },
  { keys: ['Shift', '1'], label: 'Solo Bass', group: 'Audio' },
  { keys: ['Shift', '2'], label: 'Solo Beat', group: 'Audio' },
  { keys: ['Shift', '3'], label: 'Solo Treble', group: 'Audio' },
  { keys: ['Shift', '4'], label: 'Solo Energy', group: 'Audio' },
  { keys: ['D'], label: 'Toggle debug overlay', group: 'UI' },
  { keys: ['?'], label: 'Toggle this help', group: 'UI' },
  { keys: ['Esc'], label: 'Close dialogs / help', group: 'UI' },
]

export function KeyboardShortcutsHelp() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) return
      if (e.key === '?') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // group shortcuts by their `group` field for display
  const groups = SHORTCUTS.reduce<Record<string, typeof SHORTCUTS>>((acc, s) => {
    ;(acc[s.group] = acc[s.group] || []).push(s)
    return acc
  }, {})

  return (
    <>
      {/* Floating help button (bottom-right, above footer) */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Keyboard shortcuts help"
        aria-expanded={open}
        className="fixed bottom-16 right-4 z-40 hidden h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/60 text-white/70 backdrop-blur-md transition-all hover:scale-110 hover:border-[#ff2d95]/60 hover:text-white lg:flex"
      >
        <Keyboard className="h-4 w-4" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-sonic-fade-in"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
        >
          <div
            className="relative w-full max-w-md mx-4 rounded-2xl border border-white/10 bg-[#0a0512] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute right-3 top-3 rounded-md p-1 text-white/40 hover:bg-white/5 hover:text-white"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="mb-4 flex items-center gap-2">
              <Keyboard className="h-5 w-5 text-[#ff2d95]" />
              <h2 className="text-lg font-semibold text-white">Keyboard shortcuts</h2>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {Object.entries(groups).map(([groupName, items]) => (
                <div key={groupName} className="space-y-1.5">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                    {groupName}
                  </h3>
                  {items.map((s) => (
                    <div key={s.label} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-white/70">{s.label}</span>
                      <div className="flex gap-1">
                        {s.keys.map((k) => (
                          <kbd
                            key={k}
                            className="min-w-[1.5rem] rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-center font-mono text-[10px] text-white/80"
                          >
                            {k}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className="mt-4 text-center text-[10px] text-white/30">
              Press <kbd className="rounded bg-white/10 px-1 font-mono">?</kbd> anywhere to toggle this help.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
