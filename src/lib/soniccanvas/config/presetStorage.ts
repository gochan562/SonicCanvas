import * as THREE from 'three'
import type { UserSettings } from '../audio/types'
import { DEFAULT_SETTINGS, PRESETS, applyPreset } from '../config/defaults'

/**
 * ============================================================================
 * MODULE: config/presetStorage.ts — localStorage-backed user preset library
 * ============================================================================
 *
 * WHAT IT IS
 *   A localStorage wrapper that lets users persist the current
 *   UserSettings under a custom name. Saved presets survive reloads and
 *   appear alongside the 5 shipped presets in the ControlsPanel dropdown.
 *
 * WHY IT EXISTS
 *   Shipped presets (defaults.ts PRESETS) are immutable: users can pick
 *   them and tweak sliders, but every page-load resets the sliders back
 *   to the preset's values. Without this module, a user who tunes a
 *   look they love has no way to save it for next time. presetStorage
 *   gives them a personal library that persists across sessions.
 *
 *   The two persistence modes in SonicCanvas cover two use cases:
 *     - presetStorage.ts → "my look, my browser" (private, long-term).
 *     - shareUrl.ts      → "share with a friend"      (public, one-shot).
 *
 * STORAGE LAYOUT (localStorage key `soniccanvas:user-presets`):
 *   {
 *     "version": 1,
 *     "presets": [
 *       { id, name, description, createdAt, settings: {...} },
 *       ...
 *     ]
 *   }
 *
 *   - `version` lets us bump the schema later. If we add a field (e.g.
 *     "tags: string[]"), old saved data is still readable; if we rename
 *     or remove fields, bump STORAGE_VERSION and old data is rejected
 *     (the loader returns [] — user re-saves).
 *   - `settings` mirrors the SerializedSettings shape from shareUrl.ts:
 *     colors are `#rrggbb` strings (not THREE.Color — localStorage
 *     only stores JSON, and THREE.Color has no enumerable own fields).
 *
 * WHAT GOES IN
 *   - saveUserPreset(name, settings)  → writes a new entry.
 *   - deleteUserPreset(id)            → removes an entry by id.
 *   - applyUserPreset(settings, p)    → reads one entry, applies it.
 *   - getAllPresets()                 → reads all entries for UI.
 *
 * WHAT COMES OUT
 *   - SavedPreset objects (with string colors).
 *   - UserSettings objects after color→THREE.Color conversion.
 *
 * WHAT DEPENDS ON IT
 *   - ui/store.ts (SavePresetDialog + setPreset action).
 *   - components/soniccanvas/ControlsPanel.tsx (renders the user-preset
 *     list with a delete button per entry).
 *   - config/shareUrl.ts is the *alternative* persistence path; it does
 *     NOT depend on this module, but the two are interchangeable as
 *     serialization formats (both use the same field set).
 *
 * WHAT IT DEPENDS ON
 *   - `window.localStorage` (browser API; SSR-safe guarded everywhere).
 *   - `../config/defaults` (DEFAULT_SETTINGS, PRESETS, applyPreset).
 *   - `three` (for THREE.Color rehydration at apply time).
 *
 * CUSTOMIZATION:
 *   - Bump STORAGE_VERSION when changing SavedPreset's shape; the
 *     loader will reject old data and the UI will start empty (let
 *     the user know if you do this in a release).
 *   - Add fields like `tags`, `parentPresetId` (if you want "save a
 *     variant of Cosmic") to SavedPreset + applyUserPreset.
 *
 * WARNING:
 *   - localStorage is per-browser (not per-user). On a shared computer,
 *     anyone using the same browser profile sees the saved presets.
 *     There's no account system in SonicCanvas (spec §6).
 *   - localStorage has a ~5MB limit. Each preset is ~250 bytes, so the
 *     practical limit is ~20000 presets — far beyond what any UI would
 *     sanely render, but worth noting if you import a huge library.
 *   - All functions are no-ops in SSR (typeof window === 'undefined').
 *     Don't call them from a server component.
 * ============================================================================
 */

// localStorage key — namespaced to avoid collision with other apps on
// the same origin. If you fork SonicCanvas, change this string to avoid
// clobbering the original's user presets.
const STORAGE_KEY = 'soniccanvas:user-presets'

// Level 3 SAFE PARAMETER — schema version. Bump this if you change the
// SavedPreset shape; the loader rejects payloads with a mismatched
// version (returns [] instead of risking data corruption).
const STORAGE_VERSION = 1

/**
 * A user-saved preset, as stored in localStorage. Identical to a shipped
 * Preset EXCEPT:
 *   - `id` is prefixed with `user:` so findPresetById can route to the
 *     right storage backend (built-in vs user) by inspecting the prefix.
 *   - `createdAt` timestamp for UI display ("Saved 2 hours ago").
 *   - `settings` colors are hex strings (not THREE.Color).
 */
export interface SavedPreset {
  id: string
  name: string
  description: string
  createdAt: number
  settings: {
    intensity: number
    motion: number
    glow: number
    particleAmount: number
    distortion: number
    bassReaction: number
    beatReaction: number
    trebleReaction: number
    energyReaction: number
    colorShift: number
    primaryColor: string
    secondaryColor: string
    backgroundColor: string
  }
}

/**
 * The on-disk shape: a version stamp + an array of SavedPreset.
 *
 * WHY wrap in an outer object (vs. storing the array directly): a future
 * schema bump might add top-level metadata (e.g. `savedAt`, `appName`)
 * without disturbing the array shape. The wrapper makes that additive.
 */
interface StoredShape {
  version: number
  presets: SavedPreset[]
}

/**
 * Read all user presets from localStorage (empty array on failure).
 *
 * WHY return [] on any failure: localStorage can throw (private mode,
 * quota exceeded, JSON parse error on corrupted data) and the UI must
 * never crash because of a storage hiccup. An empty list is the safe
 * degraded state — the user can still use built-in presets.
 *
 * WHY three separate guard checks: defense in depth. A user might have
 *   - an old version (data structure changed): reject → [].
 *   - a hand-edited blob with `presets` as an object, not array: reject → [].
 *   - valid JSON but corrupted field types deeper in: still readable,
 *     but applyUserPreset will produce NaN values; the UI clamps those
 *     downstream so the renderer doesn't crash.
 */
export function loadUserPresets(): SavedPreset[] {
  // SSR guard: this module is browser-only (the UI runs client-side).
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StoredShape
    // Version check — must match exactly. Mismatched versions are
    // treated as "not our data" and rejected.
    if (parsed.version !== STORAGE_VERSION) return []
    // Shape check — `presets` must be an array. A hand-edited or
    // corrupted blob might have it as something else.
    if (!Array.isArray(parsed.presets)) return []
    return parsed.presets
  } catch {
    // JSON parse error, localStorage disabled, etc. — degrade to empty.
    return []
  }
}

/**
 * Persist the full user-preset list.
 *
 * Internal helper — every write goes through here so the version stamp
 * is always consistent. The caller is responsible for reading the
 * current list first (so we don't lose existing entries).
 */
function persistUserPresets(presets: SavedPreset[]): void {
  if (typeof window === 'undefined') return
  try {
    const payload: StoredShape = { version: STORAGE_VERSION, presets }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // localStorage might be full (QuotaExceededError) or disabled
    // (private mode in some browsers). Silently ignore — the in-memory
    // list still works for the current session; it just won't persist.
  }
}

/**
 * Save the current settings as a named user preset. Returns the new
 * SavedPreset (with a generated ID and timestamp).
 *
 * ID format: `user:<base36-timestamp><random-suffix>`. The timestamp
 * makes IDs roughly sortable by creation time; the random suffix
 * prevents collisions if two presets are saved in the same millisecond
 * (very unlikely but possible with rapid-fire UI clicks).
 *
 * WHY prefix with `user:` — the findPresetById router inspects the
 * prefix to decide whether to look in PRESETS (shipped) or in
 * loadUserPresets() (user-saved). Built-in ids never start with
 * `user:` (they're plain strings like `cosmic`, `electric`).
 */
export function saveUserPreset(name: string, settings: UserSettings): SavedPreset {
  // Read the existing list first — we APPEND, we don't overwrite.
  const presets = loadUserPresets()
  // Date.now().toString(36) — base36 packs the timestamp compactly.
  // Math.random().toString(36).slice(2, 6) — 4 random chars, ~1.6B combos.
  const id = 'user:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const preset: SavedPreset = {
    id,
    name: name.trim() || 'Untitled',
    description: 'Custom preset saved on ' + new Date().toLocaleString(),
    createdAt: Date.now(),
    settings: {
      // Numeric settings — straight copy.
      intensity: settings.intensity,
      motion: settings.motion,
      glow: settings.glow,
      particleAmount: settings.particleAmount,
      distortion: settings.distortion,
      bassReaction: settings.bassReaction,
      beatReaction: settings.beatReaction,
      trebleReaction: settings.trebleReaction,
      energyReaction: settings.energyReaction,
      colorShift: settings.colorShift,
      // Colors: convert THREE.Color → hex string for JSON serialization.
      // .getHexString() returns lowercase rrggbb (no #). We prepend #
      // so the value is a valid CSS color when applied back later.
      primaryColor: '#' + settings.primaryColor.getHexString(),
      secondaryColor: '#' + settings.secondaryColor.getHexString(),
      backgroundColor: '#' + settings.backgroundColor.getHexString(),
    },
  }
  presets.push(preset)
  persistUserPresets(presets)
  return preset
}

/**
 * Delete a user preset by ID. Built-in presets can't be deleted.
 *
 * WHY the `user:` prefix guard: if this function were called with a
 * built-in id (e.g. 'cosmic'), the filter would no-op (no entry matches)
 * anyway — but the guard makes the intent explicit and lets us return
 * early without touching storage. Defensive against future UI bugs
 * that pass the wrong id.
 */
export function deleteUserPreset(id: string): void {
  if (!id.startsWith('user:')) return
  const presets = loadUserPresets().filter((p) => p.id !== id)
  persistUserPresets(presets)
}

/**
 * Apply a saved user preset onto a UserSettings object (returns a new
 * object — does not mutate the input).
 *
 * Mirrors defaults.applyPreset, but for the SavedPreset shape. Colors
 * are rehydrated from `#rrggbb` strings into THREE.Color instances.
 *
 * WHY not reuse applyPreset: SavedPreset's settings are required (not
 * Partial), so every field always exists. Skipping the undefined
 * guards saves a few cycles per apply — though for a user action that
 * runs at most once per click, this is purely cosmetic.
 */
export function applyUserPreset(settings: UserSettings, preset: SavedPreset): UserSettings {
  const next: UserSettings = { ...settings }
  const s = preset.settings
  next.intensity = s.intensity
  next.motion = s.motion
  next.glow = s.glow
  next.particleAmount = s.particleAmount
  next.distortion = s.distortion
  next.bassReaction = s.bassReaction
  next.beatReaction = s.beatReaction
  next.trebleReaction = s.trebleReaction
  next.energyReaction = s.energyReaction
  next.colorShift = s.colorShift
  // Rehydrate THREE.Color from hex string. New instance per field so
  // the caller can mutate without aliasing the saved preset's strings.
  next.primaryColor = new THREE.Color(s.primaryColor)
  next.secondaryColor = new THREE.Color(s.secondaryColor)
  next.backgroundColor = new THREE.Color(s.backgroundColor)
  return next
}

/**
 * Combined list of built-in + user presets, for UI display. Built-in
 * presets come first; user presets are appended after a virtual
 * divider (UI handles the divider; this function just returns them
 * in display order).
 *
 * WHY split return (vs. a single concatenated array): the UI needs
 * to render the two groups differently (built-ins have no delete
 * button, no "saved at" timestamp). Splitting lets the dropdown
 * component decide presentation without re-classifying by id prefix.
 */
export function getAllPresets() {
  const user = loadUserPresets()
  return { builtin: PRESETS, user }
}

/**
 * Find a preset by ID across built-in + user presets. Returns
 * `{ kind: 'builtin' | 'user', preset }` or `null`.
 *
 * WHY a kind discriminator: the caller (applyAnyPreset) needs to know
 * which applier to use — built-in presets use defaults.applyPreset
 * (handles Partial<> settings), user presets use applyUserPreset
 * (handles the full SavedPreset shape). The discriminator makes the
 * branch explicit instead of inspecting the id prefix twice.
 *
 * The return type is a union: built-in presets are `typeof PRESETS[number]`
 * (Preset), user presets are SavedPreset. The two shapes differ in:
 *   - SavedPreset has `createdAt` + non-Partial settings.
 *   - Preset has Partial<> settings.
 * Callers must use the kind to safely narrow the type.
 */
export function findPresetById(id: string): { kind: 'builtin' | 'user'; preset: SavedPreset | typeof PRESETS[number] } | null {
  // User preset path — prefix-based routing.
  if (id.startsWith('user:')) {
    const u = loadUserPresets().find((p) => p.id === id)
    if (u) return { kind: 'user', preset: u }
    return null
  }
  // Built-in preset path — scan the shipped PRESETS array.
  const b = PRESETS.find((p) => p.id === id)
  if (b) return { kind: 'builtin', preset: b }
  return null
}

/**
 * Apply any preset (built-in or user) onto a UserSettings object.
 *
 * Convenience wrapper around findPresetById + the type-specific applier.
 * If the id is unknown (user deleted a preset that's still selected),
 * returns the input settings unchanged — the store treats this as
 * "no-op" rather than crashing.
 */
export function applyAnyPreset(settings: UserSettings, id: string): UserSettings {
  const found = findPresetById(id)
  if (!found) return settings
  if (found.kind === 'user') {
    return applyUserPreset(settings, found.preset as SavedPreset)
  }
  return applyPreset(settings, found.preset as typeof PRESETS[number])
}

/**
 * Re-export DEFAULT_SETTINGS for convenience.
 *
 * WHY re-export here: callers that already import from this module
 * (e.g. store.ts reaches for DEFAULT_SETTINGS + the user-preset API)
 * can stay on a single import line. Purely a tidiness re-export;
 * the canonical source is still defaults.ts.
 */
export { DEFAULT_SETTINGS }
