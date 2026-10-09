'use client'

import { useMemo } from 'react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  Activity,
  Sparkles,
  Waves,
  Palette,
  Volume2,
  Settings2,
  Bug,
  RotateCcw,
  Gauge,
  Shuffle,
  Bookmark,
  Share2,
  Dices,
} from 'lucide-react'
import {
  PRESETS,
  SCENES,
  colorToHex,
} from '@/lib/soniccanvas/config/defaults'
import {
  useSonicStore,
  setColorSetting,
} from '@/lib/soniccanvas/ui/store'
import { useEngines } from '@/lib/soniccanvas/ui/EngineContext'
import { MappingEditor } from './MappingEditor'
import type { UserSettings } from '@/lib/soniccanvas/audio/types'

/**
 * ControlsPanel (spec §15, §18, §19, §22, §23)
 *
 * Right-hand side panel with:
 *   - visual style (scene selector + preset selector)
 *   - global visual controls (intensity / motion / glow / particles /
 *     distortion)
 *   - audio → visual mapping strengths
 *   - color controls (primary / secondary / background / color shift)
 *   - debug toggle
 *
 * All controls are reactive: they update the central Zustand store,
 * which the VisualEngine subscribes to (settingsRef) and pushes into
 * shader uniforms each frame.
 */

interface SliderRowProps {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  display?: string
  icon?: React.ReactNode
}

function SliderRow({
  label,
  description,
  value,
  min,
  max,
  step,
  onChange,
  display,
  icon,
}: SliderRowProps) {
  return (
    <div className="sonc-slider-row space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5 text-xs text-white/70">
          {icon}
          {label}
        </Label>
        <span className="font-mono text-[11px] text-white/50">
          {display ?? value.toFixed(2)}
        </span>
      </div>
      <div className="relative">
        <Slider
          value={[value]}
          min={min}
          max={max}
          step={step}
          onValueChange={(arr) => onChange(arr[0])}
          aria-label={label}
          aria-valuetext={display ?? value.toFixed(2)}
        />
        <span className="sonc-value-bubble">{display ?? value.toFixed(2)}</span>
      </div>
      {description && (
        <p className="text-[10px] leading-tight text-white/35">{description}</p>
      )}
    </div>
  )
}

const ColorRow = ({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
  disabled?: boolean
}) => (
  <div
    className={`flex items-center justify-between gap-2 transition-opacity ${
      disabled ? 'opacity-40' : 'opacity-100'
    }`}
  >
    <Label className="text-xs text-white/70">{label}</Label>

    <div className="flex items-center gap-2">
      {disabled && (
        <span className="text-[10px] text-white/40">
          Disabled for Particles
        </span>
      )}

      <div className="flex items-center gap-2 rounded-md border border-white/10 bg-black/40 px-1 py-0.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={`h-6 w-6 rounded bg-transparent ${
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          }`}
          aria-label={label}
        />

        <span className="font-mono text-[10px] uppercase text-white/60">
          {value}
        </span>
      </div>
    </div>
  </div>
)

/**
 * SceneThumbIcon - a tiny inline SVG/CSS icon hinting at each scene's
 * visual style. Purely decorative; the real scene renders in the main
 * canvas. Used in the scene thumbnail strip.
 */
function SceneThumbIcon({ id }: { id: 'liquid' | 'orbit' | 'tunnel' | 'grid' | 'particles' }) {
  const common = 'h-4 w-4'
  if (id === 'liquid') {
    // wavy lines
    return (
      <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden="true">
        <path d="M1 8 Q3 4 5 8 T9 8 T13 8 T15 8" stroke="#ff2d95" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M1 11 Q3 7 5 11 T9 11 T13 11 T15 11" stroke="#2d9bff" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
      </svg>
    )
  }
  if (id === 'orbit') {
    // concentric circles
    return (
      <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="#ff2d95" strokeWidth="1.2"/>
        <circle cx="8" cy="8" r="4" stroke="#a855f7" strokeWidth="1.2" opacity="0.7"/>
        <circle cx="8" cy="8" r="2" stroke="#2d9bff" strokeWidth="1.2" opacity="0.7"/>
        <circle cx="8" cy="8" r="0.8" fill="#fff"/>
      </svg>
    )
  }
  if (id === 'tunnel') {
    // nested squares receding to center
    return (
      <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden="true">
        <rect x="1" y="1" width="14" height="14" stroke="#ff2d95" strokeWidth="1"/>
        <rect x="3" y="3" width="10" height="10" stroke="#a855f7" strokeWidth="1" opacity="0.7" transform="rotate(45 8 8)"/>
        <rect x="5" y="5" width="6" height="6" stroke="#2d9bff" strokeWidth="1" opacity="0.7"/>
        <rect x="7" y="7" width="2" height="2" fill="#fff"/>
      </svg>
    )
  }
  if (id === 'grid') {
    // perspective grid
    return (
      <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden="true">
        <path d="M2 14 L8 4 L14 14" stroke="#ff2d95" strokeWidth="1.2" strokeLinecap="round"/>
        <path d="M1 14 L4 11 L7 14 L10 11 L13 14 L15 12" stroke="#2d9bff" strokeWidth="1.2" strokeLinecap="round" opacity="0.7"/>
        <line x1="0" y1="14" x2="16" y2="14" stroke="#a855f7" strokeWidth="1"/>
      </svg>
    )
  }
  // particles - scattered dots
  return (
    <svg viewBox="0 0 16 16" className={common} fill="none" aria-hidden="true">
      <circle cx="3" cy="4" r="0.9" fill="#ff2d95"/>
      <circle cx="7" cy="3" r="0.7" fill="#a855f7"/>
      <circle cx="12" cy="5" r="1" fill="#2d9bff"/>
      <circle cx="4" cy="9" r="0.8" fill="#a855f7"/>
      <circle cx="9" cy="8" r="1.1" fill="#ff2d95"/>
      <circle cx="13" cy="10" r="0.7" fill="#2d9bff"/>
      <circle cx="3" cy="13" r="0.9" fill="#2d9bff"/>
      <circle cx="8" cy="12" r="0.7" fill="#ff2d95"/>
      <circle cx="12" cy="13" r="0.8" fill="#a855f7"/>
    </svg>
  )
}

export function ControlsPanel() {
  const settings = useSonicStore((s) => s.settings)
  const activePresetId = useSonicStore((s) => s.activePresetId)
  const activeScene = useSonicStore((s) => s.activeScene)
  const primaryColorDisabled = activeScene === 'particles'
  const autoScene = useSonicStore((s) => s.autoScene)
  const transitionStyle = useSonicStore((s) => s.transitionStyle)
  const debug = useSonicStore((s) => s.debug)
  const { setScene, setAutoSceneMode } = useEngines()

  const update = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) =>
    useSonicStore.getState().updateSettings({ [key]: value } as Partial<UserSettings>)

  const activePreset = useMemo(
    () => PRESETS.find((p) => p.id === activePresetId),
    [activePresetId]
  )

  // whether current settings differ from the active preset (used for badge)
  const dirty = useMemo(() => {
    if (!activePreset) return false
    const s = activePreset.settings
    if (s.intensity !== undefined && Math.abs(s.intensity - settings.intensity) > 0.01) return true
    if (s.glow !== undefined && Math.abs(s.glow - settings.glow) > 0.01) return true
    return false
  }, [activePreset, settings])

  return (
    <aside className="scroll-sonic flex max-h-[calc(100vh-180px)] w-full flex-col gap-3 overflow-y-auto pr-1 [&>*]:shrink-0 lg:w-[340px] lg:shrink-0">
      {/* Visual style — scene + preset */}
      <Card className="sonic-card-hover sonc-card-enter border-white/10 bg-white/[0.02] text-white backdrop-blur">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-[#ff2d95]" />
            Visual Style
          </CardTitle>
          <CardDescription className="text-xs text-white/40">
            Pick a scene and a preset mood.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-white/70">Scene</Label>
            <Select
              value={activeScene}
              onValueChange={(v) => setScene(v as 'liquid' | 'orbit' | 'tunnel' | 'grid' | 'particles')}
              disabled={autoScene}
            >
              <SelectTrigger className={`bg-black/40 text-white ${autoScene ? 'opacity-50' : ''}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCENES.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="scene-option">
                    <div className="flex flex-col">
                      <span className="font-medium">{s.name}</span>
                      <span className="text-[10px] text-white/40">{s.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Scene thumbnail strip — quick visual scene switcher */}
          <div className="grid grid-cols-5 gap-1">
            {SCENES.map((s) => {
              const active = s.id === activeScene && !autoScene
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={autoScene}
                  onClick={() => setScene(s.id)}
                  className={[
                    'group relative flex h-12 flex-col items-center justify-center overflow-hidden rounded-md border px-0.5 text-[9px] font-medium leading-tight transition-all',
                    active
                      ? 'border-[#ff2d95] bg-gradient-to-br from-[#ff2d95]/20 to-[#2d9bff]/20 text-white shadow-md shadow-[#ff2d95]/20'
                      : 'border-white/10 bg-black/30 text-white/50 hover:border-white/30 hover:text-white/80',
                    autoScene ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:scale-[1.05]',
                  ].join(' ')}
                  aria-label={`Switch to ${s.name} scene`}
                  aria-pressed={active}
                  title={s.description}
                >
                  <SceneThumbIcon id={s.id} />
                  <span className="mt-0.5 truncate w-full text-center">
                    {/* short label: strip common words for compactness */}
                    {s.name.replace(' Plasma', '').replace(' Field', '')}
                  </span>
                </button>
              )
            })}
          </div>
          {/* Auto-scene toggle + shuffle button */}
          <div className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-black/30 px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <Shuffle className="h-3.5 w-3.5 text-[#a855f7]" />
              <div className="flex flex-col">
                <span className="text-xs text-white/80">Auto-scene mode</span>
                <span className="text-[10px] text-white/40">
                  Rotate scenes based on energy / drops
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={autoScene}
                onClick={() => {
                  const scenes = SCENES.filter(s => s.id !== activeScene)
                  const pick = scenes[Math.floor(Math.random() * scenes.length)]
                  if (pick) setScene(pick.id)
                }}
                className={[
                  'flex items-center justify-center rounded-md border h-7 w-7 transition-all',
                  autoScene
                    ? 'border-white/5 bg-black/20 text-white/20 cursor-not-allowed'
                    : 'border-white/10 bg-black/30 text-white/60 hover:border-[#a855f7]/50 hover:text-white hover:scale-110',
                ].join(' ')}
                title="Shuffle to a random scene"
                aria-label="Shuffle scene"
              >
                <Dices className="h-3 w-3" />
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={autoScene}
                onClick={() => setAutoSceneMode(!autoScene)}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  autoScene ? 'bg-gradient-to-r from-[#ff2d95] to-[#2d9bff]' : 'bg-white/15'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    autoScene ? 'translate-x-0.5' : 'translate-x-4'
                  }`}
                />
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs text-white/70">Preset</Label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('soniccanvas:open-save-preset'))}
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-white/60 transition-colors hover:border-[#ff2d95]/40 hover:text-white"
                  title="Save current settings as a preset"
                >
                  <Bookmark className="h-2.5 w-2.5" />
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => window.dispatchEvent(new CustomEvent('soniccanvas:open-share-preset'))}
                  className="flex items-center gap-1 rounded-md border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-white/60 transition-colors hover:border-[#2d9bff]/40 hover:text-white"
                  title="Share current settings via URL"
                >
                  <Share2 className="h-2.5 w-2.5" />
                  Share
                </button>
                <button
                  type="button"
                  onClick={() => {
                    import('@/lib/soniccanvas/config/Randomizer').then(({ randomizeSettings }) => {
                      const { settings: rand, mappingCurves: randCurves } = randomizeSettings(useSonicStore.getState().settings)
                      useSonicStore.getState().updateSettings({
                        intensity: rand.intensity,
                        motion: rand.motion,
                        glow: rand.glow,
                        particleAmount: rand.particleAmount,
                        distortion: rand.distortion,
                        bassReaction: rand.bassReaction,
                        beatReaction: rand.beatReaction,
                        trebleReaction: rand.trebleReaction,
                        energyReaction: rand.energyReaction,
                        colorShift: rand.colorShift,
                        primaryColor: rand.primaryColor,
                        secondaryColor: rand.secondaryColor,
                        backgroundColor: rand.backgroundColor,
                      })
                      useSonicStore.getState().setMappingCurves(randCurves)
                      import('@/hooks/use-toast').then(({ toast }) => {
                        toast({ title: 'Randomized!', description: 'Settings + mapping curves regenerated.' })
                      })
                    })
                  }}
                  className="sonc-btn-pop flex items-center gap-1 rounded-md border border-white/10 bg-gradient-to-br from-[#ff2d95]/20 to-[#2d9bff]/20 px-1.5 py-0.5 text-[10px] text-white/80 transition-all hover:border-[#a855f7]/50 hover:text-white"
                  title="Randomize all settings + curves"
                >
                  <Dices className="h-2.5 w-2.5" />
                  Random
                </button>
              </div>
            </div>
            <Select
              value={activePresetId}
              onValueChange={(v) => useSonicStore.getState().setPreset(v)}
            >
              <SelectTrigger className="bg-black/40 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <div className="flex items-center gap-2">
                      <span
                        className="sonc-preset-swatch shrink-0"
                        style={{
                          background: `linear-gradient(90deg, ${p.settings.primaryColor}, ${p.settings.secondaryColor})`,
                        }}
                        aria-hidden="true"
                      />
                      <div className="flex flex-col">
                        <span className="font-medium">{p.name}</span>
                        <span className="text-[10px] text-white/40">{p.description}</span>
                      </div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {dirty && (
              <Badge variant="secondary" className="mt-1 text-[10px]">
                customized
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Global visual controls */}
      <Card className="sonic-card-hover sonc-card-enter border-white/10 bg-white/[0.02] text-white backdrop-blur">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gauge className="h-4 w-4 text-[#2d9bff]" />
            Visual Controls
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SliderRow
            label="Intensity"
            value={settings.intensity}
            min={0}
            max={3}
            step={0.01}
            onChange={(v) => update('intensity', v)}
            icon={<Activity className="h-3 w-3" />}
            description="Overall brightness and reaction strength."
          />
          <SliderRow
            label="Motion"
            value={settings.motion}
            min={0}
            max={3}
            step={0.01}
            onChange={(v) => update('motion', v)}
            icon={<Waves className="h-3 w-3" />}
            description="Speed of all animation."
          />
          <SliderRow
            label="Glow"
            value={settings.glow}
            min={0}
            max={3}
            step={0.01}
            onChange={(v) => update('glow', v)}
            description="Bloom / light intensity."
          />
          <SliderRow
            label="Particles"
            value={settings.particleAmount}
            min={0}
            max={2}
            step={0.01}
            onChange={(v) => update('particleAmount', v)}
            description="Density of procedural particles / detail."
          />
          <SliderRow
            label="Distortion"
            value={settings.distortion}
            min={0}
            max={2}
            step={0.01}
            onChange={(v) => update('distortion', v)}
            description="Fluid warping of the field."
          />
        </CardContent>
      </Card>

      {/* Audio → visual mappings */}
      <Card className="sonic-card-hover sonc-card-enter border-white/10 bg-white/[0.02] text-white backdrop-blur">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-[#ff2d95]" />
            Audio Mapping
          </CardTitle>
          <CardDescription className="text-xs text-white/40">
            How strongly each part of the music drives the visuals.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SliderRow
            label="Bass reaction"
            value={settings.bassReaction}
            min={0}
            max={3}
            step={0.01}
            onChange={(v) => update('bassReaction', v)}
            description="Low frequencies → scale / displacement."
          />
          <SliderRow
            label="Beat reaction"
            value={settings.beatReaction}
            min={0}
            max={3}
            step={0.01}
            onChange={(v) => update('beatReaction', v)}
            description="Detected beats → impact pulses."
          />
          <SliderRow
            label="Treble reaction"
            value={settings.trebleReaction}
            min={0}
            max={3}
            step={0.01}
            onChange={(v) => update('trebleReaction', v)}
            description="High frequencies → particles / detail."
          />
          <SliderRow
            label="Energy reaction"
            value={settings.energyReaction}
            min={0}
            max={3}
            step={0.01}
            onChange={(v) => update('energyReaction', v)}
            description="Overall loudness → brightness / glow."
          />
        </CardContent>
      </Card>

      {/* Mapping curve editor (spec §46 — mapping editor) */}
      <MappingEditor />

      {/* Colors */}
      <Card className="sonic-card-hover sonc-card-enter border-white/10 bg-white/[0.02] text-white backdrop-blur">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Palette className="h-4 w-4 text-[#ff2d95]" />
            Colors
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ColorRow
            label="Primary"
            value={colorToHex(settings.primaryColor)}
            onChange={(h) => setColorSetting('primaryColor', h)}
            disabled={primaryColorDisabled}
          />
          <ColorRow
            label="Secondary"
            value={colorToHex(settings.secondaryColor)}
            onChange={(h) => setColorSetting('secondaryColor', h)}
          />
          <ColorRow
            label="Background"
            value={colorToHex(settings.backgroundColor)}
            onChange={(h) => setColorSetting('backgroundColor', h)}
          />
          <SliderRow
            label="Color shift"
            value={settings.colorShift}
            min={-1}
            max={1}
            step={0.01}
            onChange={(v) => update('colorShift', v)}
            display={settings.colorShift.toFixed(2)}
            description="Rotate the palette phase."
          />
        </CardContent>
      </Card>

      {/* Advanced / debug */}
      <Accordion type="single" collapsible className="rounded-xl border border-white/10 bg-white/[0.02] px-3 text-white">
        <AccordionItem value="adv" className="border-0">
          <AccordionTrigger className="py-3 text-sm hover:no-underline">
            <span className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-white/60" />
              Advanced
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pb-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full border-white/15 bg-transparent text-white/80 hover:bg-white/5"
              onClick={() => useSonicStore.getState().setPreset(activePresetId)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to preset
            </Button>
            {/* Transition style selector (spec §17 — scene transitions) */}
            <div className="space-y-1.5">
              <Label className="text-xs text-white/70">Scene transition</Label>
              <div className="grid grid-cols-3 gap-1">
                {(['crossfade', 'wipe', 'zoom'] as const).map((style) => (
                  <button
                    key={style}
                    type="button"
                    onClick={() => useSonicStore.getState().setTransitionStyle(style)}
                    className={[
                      'rounded-md border px-2 py-1.5 text-[10px] font-medium capitalize transition-all',
                      transitionStyle === style
                        ? 'border-[#ff2d95] bg-gradient-to-br from-[#ff2d95]/20 to-[#2d9bff]/20 text-white shadow-md shadow-[#ff2d95]/20'
                        : 'border-white/10 bg-black/30 text-white/60 hover:border-white/30 hover:text-white/90',
                    ].join(' ')}
                    aria-pressed={transitionStyle === style}
                  >
                    {style}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-white/35">
                How scenes morph into each other when switching.
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-1.5 text-xs text-white/70">
                <Bug className="h-3 w-3" />
                Debug overlay
              </Label>
              <Button
                size="sm"
                variant={debug ? 'default' : 'outline'}
                onClick={() => useSonicStore.getState().setDebug(!debug)}
                className="h-7 px-2 text-xs"
              >
                {debug ? 'On' : 'Off'}
              </Button>
            </div>
            <p className="text-[10px] text-white/35">
              Tip: press <kbd className="rounded bg-white/10 px-1">Space</kbd> to play/pause, ←/→ to seek 5s, <kbd className="rounded bg-white/10 px-1">?</kbd> for all shortcuts.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <div className="hidden lg:block flex-1" />
    </aside>
  )
}

// Volume icon re-exported for PlayerBar convenience.
export { Volume2 }
