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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Bookmark, Trash2, Check, AlertCircle } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { useSonicStore } from '@/lib/soniccanvas/ui/store'
import {
  loadUserPresets,
  saveUserPreset,
  deleteUserPreset,
  applyAnyPreset,
  type SavedPreset,
} from '@/lib/soniccanvas/config/presetStorage'

/**
 * SavePresetDialog
 *
 * Modal for saving the current settings as a named user preset (stored
 * in localStorage, spec §46) and listing/deleting previously saved
 * presets. Opens via the `soniccanvas:open-save-preset` CustomEvent
 * dispatched by the ControlsPanel "Save preset" button.
 */
export function SavePresetDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [userPresets, setUserPresets] = useState<SavedPreset[]>([])
  const [justSavedId, setJustSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const settings = useSonicStore((s) => s.settings)

  // refresh the user-preset list whenever the dialog opens
  useEffect(() => {
    const onOpen = () => {
      setUserPresets(loadUserPresets())
      setName('')
      setError(null)
      setJustSavedId(null)
      setOpen(true)
    }
    window.addEventListener('soniccanvas:open-save-preset', onOpen)
    return () => window.removeEventListener('soniccanvas:open-save-preset', onOpen)
  }, [])

  const handleSave = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Please enter a preset name.')
      return
    }
    if (trimmed.length > 40) {
      setError('Preset name must be 40 characters or fewer.')
      return
    }
    try {
      const saved = saveUserPreset(trimmed, settings)
      setUserPresets(loadUserPresets())
      setJustSavedId(saved.id)
      setName('')
      setError(null)
      toast({ title: 'Preset saved', description: `"${saved.name}" is now in your saved presets.` })
      // auto-clear the "saved" highlight after a moment
      setTimeout(() => setJustSavedId((id) => (id === saved.id ? null : id)), 2000)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save preset')
      toast({ title: 'Failed to save preset', description: e?.message, variant: 'destructive' })
    }
  }

  const handleDelete = (id: string) => {
    deleteUserPreset(id)
    setUserPresets(loadUserPresets())
    toast({ title: 'Preset deleted' })
  }

  const handleApply = (id: string) => {
    const next = applyAnyPreset(settings, id)
    useSonicStore.getState().updateSettings({
      intensity: next.intensity,
      motion: next.motion,
      glow: next.glow,
      particleAmount: next.particleAmount,
      distortion: next.distortion,
      bassReaction: next.bassReaction,
      beatReaction: next.beatReaction,
      trebleReaction: next.trebleReaction,
      energyReaction: next.energyReaction,
      colorShift: next.colorShift,
      primaryColor: next.primaryColor,
      secondaryColor: next.secondaryColor,
      backgroundColor: next.backgroundColor,
    })
    // mark active preset id so the dropdown shows the user preset name
    useSonicStore.setState({ activePresetId: id })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
      <DialogContent className="border-white/10 bg-[#0a0512] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bookmark className="h-5 w-5 text-[#ff2d95]" />
            Save preset
          </DialogTitle>
          <DialogDescription className="text-white/50">
            Save the current visual settings to your browser. Presets persist across sessions — no account needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="preset-name" className="text-xs text-white/70">Preset name</Label>
            <div className="flex gap-2">
              <Input
                id="preset-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Dreamy synthscape"
                maxLength={40}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
                className="border-white/15 bg-black/40 text-white placeholder:text-white/30"
              />
              <Button
                onClick={handleSave}
                className="bg-gradient-to-r from-[#ff2d95] to-[#2d9bff] text-white hover:opacity-90"
              >
                Save
              </Button>
            </div>
            {error && (
              <div className="flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle className="h-3 w-3" />
                {error}
              </div>
            )}
          </div>

          {userPresets.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-white/70">Your saved presets</Label>
              <div className="scroll-sonic max-h-56 space-y-1 overflow-y-auto pr-1">
                {userPresets.slice().reverse().map((p) => (
                  <div
                    key={p.id}
                    className={[
                      'flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 transition-colors',
                      justSavedId === p.id
                        ? 'border-emerald-500/40 bg-emerald-500/10'
                        : 'border-white/10 bg-black/30 hover:border-white/20',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      onClick={() => handleApply(p.id)}
                      className="flex flex-1 flex-col items-start text-left"
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium text-white">
                        {justSavedId === p.id && <Check className="h-3 w-3 text-emerald-400" />}
                        {p.name}
                      </span>
                      <span className="text-[10px] text-white/40">
                        {new Date(p.createdAt).toLocaleString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(p.id)}
                      className="rounded p-1 text-white/40 hover:bg-red-500/20 hover:text-red-400"
                      aria-label={`Delete preset ${p.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-white/30">
                Click a preset to apply it. Saved presets are stored in your browser only.
              </p>
            </div>
          )}
          {userPresets.length === 0 && (
            <p className="rounded-md border border-dashed border-white/10 px-3 py-3 text-center text-xs text-white/30">
              No saved presets yet. Enter a name above and click Save to create your first one.
            </p>
          )}
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
