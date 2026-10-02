'use client'

import { Button } from '@/components/ui/button'
import { Download, Music4, Code2 } from 'lucide-react'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'

/**
 * Header — app title + global actions (export).
 */
export function Header() {
  const track = useSonicStore((s) => s.track)
  const isExporting = useSonicStore((s) => s.isExporting)
  const setExporting = useSonicStore((s) => s.setExporting)
  // We trigger the export dialog by toggling `isExporting` true *and*
  // a separate "dialog open" flag in store; but for simplicity we use
  // the exportBlobUrl-presence to decide dialog state, plus an
  // `exportDialogOpen` boolean. To keep the store surface small we
  // just use a local boolean via a hidden state in ExportDialog.
  // Here the button dispatches a custom event the dialog listens to.
  const openExport = () => {
    if (!track) return
    window.dispatchEvent(new CustomEvent('soniccanvas:open-export'))
  }

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-white/10 bg-black/70 px-4 py-3 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#ff2d95] to-[#2d9bff] shadow-lg shadow-[#ff2d95]/30">
          <Music4 className="h-5 w-5 text-white" />
          <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-[#ff2d95] to-[#2d9bff] opacity-0 blur-md transition-opacity duration-300 hover:opacity-60" />
        </div>
        <div>
          <h1 className="text-lg font-semibold leading-tight">
            Sonic
            <span className="sonic-title-shimmer bg-gradient-to-r from-[#ff2d95] via-[#a855f7] to-[#2d9bff] bg-clip-text text-transparent">
              Canvas
            </span>
          </h1>
          <p className="flex items-center gap-1.5 text-[11px] leading-tight text-white/40">
            <span>Procedural music-video generator</span>
            {track && (
              <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/60">
                <span className="sonic-eq-bar" />
                <span className="sonic-eq-bar" />
                <span className="sonic-eq-bar" />
                <span className="sonic-eq-bar" />
                <span className="ml-1">live</span>
              </span>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <a
          href="https://github.com"
          target="_blank"
          rel="noreferrer"
          className="hidden sm:inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white"
        >
          <Code2 className="h-4 w-4" />
          Source
        </a>
        <Button
          onClick={openExport}
          disabled={!track || isExporting}
          className="group relative overflow-hidden bg-gradient-to-r from-[#ff2d95] to-[#2d9bff] text-white shadow-lg shadow-[#ff2d95]/20 transition-all hover:shadow-[#ff2d95]/40 hover:brightness-110"
        >
          <Download className="h-4 w-4 transition-transform group-hover:-translate-y-0.5" />
          Export Video
        </Button>
      </div>
    </header>
  )
}
