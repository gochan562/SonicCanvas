'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Download, Loader2, Film, CheckCircle2, AlertCircle } from 'lucide-react'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import { useEngines } from '@/lib/soniccanvas/ui/EngineContext'
import type { ExportQuality, ExportResolution } from '@/lib/soniccanvas/export/VideoExporter'

/**
 * ExportDialog (spec §30)
 *
 * Modal that lets the user choose resolution + quality, start a clean
 * export pass, view progress, and download the resulting WebM.
 *
 * The export runs a dedicated clean recording pass (spec §32) — it
 * resets playback to the start, creates a fresh audio source, starts
 * the MediaRecorder + canvas.captureStream, and stops when the audio
 * ends.
 */
export function ExportDialog() {
  const [open, setOpen] = useState(false)
  const [resolution, setResolution] = useState<ExportResolution>('preview')
  const [quality, setQuality] = useState<ExportQuality>('high')

  const isExporting = useSonicStore((s) => s.isExporting)
  const exportProgress = useSonicStore((s) => s.exportProgress)
  const exportBlobUrl = useSonicStore((s) => s.exportBlobUrl)
  const error = useSonicStore((s) => s.error)
  const track = useSonicStore((s) => s.track)
  const { export: exportVideo, cancelExport, closeExportBlob } = useEngines()

  // listen for header's "open export" event
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener('soniccanvas:open-export', onOpen)
    return () => window.removeEventListener('soniccanvas:open-export', onOpen)
  }, [])

  const startExport = () => {
    void exportVideo({ resolution, quality })
  }

  const close = () => {
    setOpen(false)
    // if there's a blob URL lingering, clear it
    if (exportBlobUrl) closeExportBlob()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isExporting) close() }}>
      <DialogContent className="border-white/10 bg-[#0a0512] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Film className="h-5 w-5 text-[#ff2d95]" />
            Export video
          </DialogTitle>
          <DialogDescription className="text-white/50">
            Records a clean pass with synced audio + visuals. Don&apos;t close this tab while recording.
          </DialogDescription>
        </DialogHeader>

        {exportBlobUrl ? (
          // success state
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-300">
              <CheckCircle2 className="h-5 w-5" />
              <div className="text-sm">
                <div className="font-medium">Export complete</div>
                <div className="text-xs text-emerald-300/70">
                  Your music video is ready to download.
                </div>
              </div>
            </div>
            <a
              href={exportBlobUrl}
              download={`${(track?.fileName ?? 'soniccanvas').replace(/\.[^.]+$/, '')}.webm`}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-[#ff2d95] to-[#2d9bff] px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-[#ff2d95]/30 hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              Download WebM
            </a>
          </div>
        ) : isExporting ? (
          // recording state
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-white/60">
                <span className="flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Recording…
                </span>
                <span className="font-mono">{Math.round(exportProgress * 100)}%</span>
              </div>
              <Progress value={exportProgress * 100} className="sonc-progress-grad h-2.5 bg-white/10" />
              <p className="text-[10px] text-white/40">
                The exporter is capturing the canvas + audio in real time. Playback will
                resume automatically after the export finishes.
              </p>
            </div>
            <Button variant="outline" onClick={cancelExport} className="w-full border-white/20 bg-transparent text-white hover:bg-white/5">
              Cancel
            </Button>
          </div>
        ) : (
          // setup state
          <div className="space-y-4 py-2">
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 text-xs text-red-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs text-white/70">Resolution</Label>
              <Select value={resolution} onValueChange={(v) => setResolution(v as ExportResolution)}>
                <SelectTrigger className="bg-black/40 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preview">Preview size (current canvas)</SelectItem>
                  <SelectItem value="720p">720p (1280×720)</SelectItem>
                  <SelectItem value="1080p">1080p (1920×1080)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-white/70">Quality</Label>
              <Select value={quality} onValueChange={(v) => setQuality(v as ExportQuality)}>
                <SelectTrigger className="bg-black/40 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low (2 Mbps — smaller file)</SelectItem>
                  <SelectItem value="medium">Medium (5 Mbps)</SelectItem>
                  <SelectItem value="high">High (8 Mbps — best quality)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 p-3 text-[11px] text-white/50">
              Output: WebM with synced audio. Browser support required
              (Chrome, Edge, Firefox).
            </div>
            <Button
              onClick={startExport}
              disabled={!track}
              className="w-full bg-gradient-to-r from-[#ff2d95] to-[#2d9bff] text-white hover:opacity-90"
            >
              <Film className="h-4 w-4" />
              Start export
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={isExporting} className="text-white/60 hover:text-white">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
