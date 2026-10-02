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
import { Share2, Copy, Check, ExternalLink } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import { buildShareUrl } from '@/lib/soniccanvas/config/shareUrl'

/**
 * SharePresetDialog
 *
 * Modal that generates a shareable URL for the current visual
 * settings (spec §46 — "share preset" feature). The settings are
 * serialized into a compact base64url hash so the URL is short
 * enough to paste into chat / email.
 *
 * Opens via the `soniccanvas:open-share-preset` CustomEvent.
 */
export function SharePresetDialog() {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState(false)

  const settings = useSonicStore((s) => s.settings)
  const activeScene = useSonicStore((s) => s.activeScene)
  const mappingCurves = useSonicStore((s) => s.mappingCurves)

  useEffect(() => {
    const onOpen = () => {
      setUrl(buildShareUrl(settings, activeScene, mappingCurves))
      setCopied(false)
      setOpen(true)
    }
    window.addEventListener('soniccanvas:open-share-preset', onOpen)
    return () => window.removeEventListener('soniccanvas:open-share-preset', onOpen)
  }, [settings, activeScene, mappingCurves])

  const handleCopy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(url)
      } else {
        // fallback: select-and-execCommand for older browsers
        const ta = document.createElement('textarea')
        ta.value = url
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      toast({ title: 'URL copied to clipboard' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ title: 'Could not copy automatically', description: 'Select the URL and press Ctrl+C.', variant: 'destructive' })
    }
  }

  const handleOpenInNewTab = () => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
      <DialogContent className="border-white/10 bg-[#0a0512] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-5 w-5 text-[#ff2d95]" />
            Share preset
          </DialogTitle>
          <DialogDescription className="text-white/50">
            Anyone who opens this URL will see SonicCanvas with your exact visual settings applied. The settings live in the URL hash — no server, no account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <label className="text-xs text-white/70" htmlFor="share-url">
              Shareable URL
            </label>
            <div className="flex gap-2">
              <input
                id="share-url"
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 flex-1 rounded-md border border-white/15 bg-black/40 px-3 font-mono text-[11px] text-white/80 outline-none focus:border-[#ff2d95]/60"
              />
              <Button
                onClick={handleCopy}
                className="bg-gradient-to-r from-[#ff2d95] to-[#2d9bff] text-white hover:opacity-90"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-white/60">
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[#2d9bff]" />
            <button
              type="button"
              onClick={handleOpenInNewTab}
              className="underline decoration-dotted underline-offset-2 hover:text-white"
            >
              Open in a new tab
            </button>
            <span className="text-white/30">to preview the shared settings.</span>
          </div>
          <p className="text-[10px] text-white/30">
            The URL encodes all current visual controls, audio→visual mappings, colors, and the active scene. It does not include your audio file.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} className="text-white/60 hover:text-white">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
