import * as THREE from 'three'
import type { UserSettings } from '../audio/types'
import type { MappingCurve, MappingKey } from '../visuals/MappingCurves'

/**
 * ============================================================================
 * MODULE: config/shareUrl.ts — encode/decode UserSettings as a URL hash
 * ============================================================================
 *
 * WHAT IT IS
 *   A pure serializer that converts the live UserSettings (which contains
 *   mutable THREE.Color instances) into a compact base64url string suitable
 *   for a URL hash, and back. Users click "Share" → app builds a URL like
 *   `https://app/#preset=eyJ2IjoxLCJpbnRlbnNpdHkiOjEuMH0` → recipient opens
 *   it → app reads the hash on first paint and applies the encoded settings.
 *
 * WHY IT EXISTS
 *   presetStorage.ts is per-browser; it doesn't help a user share their
 *   look with a friend. shareUrl.ts is the *portable* persistence path:
 *   the entire settings blob is in the URL itself, no server round-trip,
 *   no account, no database. This is consistent with spec §6 ("no backend").
 *
 *   Two persistence modes in SonicCanvas cover two use cases:
 *     - presetStorage.ts → "my look, my browser" (private, long-term).
 *     - shareUrl.ts      → "share with a friend"  (public, one-shot).
 *   Both serialize the same field set; they're interchangeable formats.
 *
 * FORMAT
 *   #preset=<base64url-encoded-JSON>
 *
 *   The JSON shape is `SerializedSettings` below — a plain object with
 *   numbers + hex color strings + optional activeScene + optional
 *   mappingCurves. The JSON is small (~300 bytes typically), so the
 *   base64url-encoded form is short enough to paste into a chat message.
 *
 *   Versioned (`v: 1`) for forward compatibility. Bumping VERSION
 *   silently invalidates old URLs (readSettingsFromHash returns null);
 *   the app boots with DEFAULT_SETTINGS instead.
 *
 * WHAT GOES IN
 *   - encodeSettingsToHash(settings, activeScene?, mappingCurves?) →
 *     a `#preset=...` string.
 *   - buildShareUrl(...) → full URL including origin + pathname.
 *   - readSettingsFromHash() → reads window.location.hash, returns the
 *     SerializedSettings (or null).
 *   - clearSettingsHash() → strips the hash from the URL after applying
 *     (so a refresh doesn't re-apply a stale preset).
 *
 * WHAT COMES OUT
 *   - SerializedSettings (JSON-friendly) and the live UserSettings shape
 *     (with THREE.Color rehydrated) after deserializeSettings.
 *
 * WHAT DEPENDS ON IT
 *   - ui/store.ts (calls readSettingsFromHash on mount).
 *   - components/soniccanvas/ShareDialog.tsx (calls buildShareUrl on
 *     "Copy link" click).
 *   - app/page.tsx (calls clearSettingsHash after applying a shared
 *     preset, so reload doesn't re-trigger).
 *
 * WHAT IT DEPENDS ON
 *   - `btoa` / `atob` (browser globals; falls back to Node Buffer for
 *     SSR or test environments — see base64UrlEncode).
 *   - `three` (for THREE.Color rehydration in deserializeSettings).
 *   - `../audio/types` (UserSettings contract).
 *   - `../visuals/MappingCurves` (MappingCurve / MappingKey for the
 *     optional curves field).
 *
 * CUSTOMIZATION:
 *   - To ship a v2 schema (e.g. adding a `tags: string[]` field), bump
 *     VERSION to 2 and update serialize/deserialize. Old v1 URLs will
 *     be silently rejected — recipients get DEFAULT_SETTINGS.
 *   - To compress further (the JSON is ~300 bytes), swap JSON.stringify
 *     for a binary format (msgpack). The base64 layer stays the same.
 *
 * WARNING:
 *   - URLs have practical length limits (~2k chars in old browsers,
 *     ~64k in modern ones). A typical settings blob is ~300 bytes →
 *     ~400 base64 chars — well within limits. But a future schema that
 *     bakes in mapping curves with many control points could blow past
 *     the limit; watch the URL length when extending.
 *   - base64url is NOT encryption. The hash is trivially decodable by
 *     anyone who has the URL. Don't put anything sensitive in it.
 *   - The hash fragment (`#...`) is NOT sent to the server in HTTP
 *     requests, so the encoded settings never leave the client. This
 *     is by design (spec §6 — no backend).
 * ============================================================================
 */

// Level 3 SAFE PARAMETER — schema version. Bump when changing the
// SerializedSettings shape; readers reject mismatched versions.
const VERSION = 1
// The hash key that prefixes the encoded blob. `#preset=<blob>`.
// Single-key design — if you need to encode more than one thing in the
// URL (e.g. `#preset=...&scene=...`), extend the parser, don't add a
// second key prefix.
const HASH_KEY = 'preset'

/**
 * The JSON-serializable shape that goes into the URL hash.
 *
 * WHY a separate type (not UserSettings): UserSettings uses THREE.Color
 * instances for fast GPU uniform upload. THREE.Color has no enumerable
 * own fields, so JSON.stringify produces `{}` for it. We need strings
 * (`#rrggbb`) for the JSON round-trip.
 *
 * The fields are *required* (not Partial<>) because share URLs encode a
 * complete snapshot — if a field is missing, the recipient gets
 * undefined, which would NaN the VisualMapper. The encoder always
 * writes all fields; the decoder always reads all fields.
 *
 * `activeScene` is optional — the encoder only writes it if the user
 * has explicitly picked a scene (the cold-start scene is left out so
 * a recipient who hasn't loaded a track yet doesn't get a scene
 * assigned to a non-existent track).
 */
export interface SerializedSettings {
  v: number
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
  activeScene?: string
  /** Optional mapping curves (spec §46 — mapping editor) */
  mappingCurves?: Record<MappingKey, MappingCurve>
}

/**
 * Convert the live UserSettings (with THREE.Color instances) into a
 * plain JSON-serializable object. Optionally includes the mapping
 * curves so they can be shared via URL.
 *
 * Pure function: returns a fresh object, doesn't touch the input.
 *
 * WHY write `'#' + c.getHexString()` instead of `c.getStyle()`: the
 * latter returns `rgb(r, g, b)` which is longer in JSON and isn't
 * accepted by <input type=color>. Hex strings are the universal color
 * currency across the SonicCanvas UI.
 */
export function serializeSettings(
  settings: UserSettings,
  activeScene?: string,
  mappingCurves?: Record<MappingKey, MappingCurve>
): SerializedSettings {
  const out: SerializedSettings = {
    // Version stamp — readers reject blobs with mismatched versions.
    v: VERSION,
    // Numeric fields — straight copy.
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
    // Colors: convert THREE.Color → `#rrggbb` string for JSON.
    primaryColor: '#' + settings.primaryColor.getHexString(),
    secondaryColor: '#' + settings.secondaryColor.getHexString(),
    backgroundColor: '#' + settings.backgroundColor.getHexString(),
    activeScene,
  }
  // Mapping curves are optional — only included if the user has
  // customized them past defaults. Keeps URLs shorter for the common
  // case where the user is just sharing a palette tweak.
  if (mappingCurves) out.mappingCurves = mappingCurves
  return out
}

/**
 * Convert a serialized settings object back into live UserSettings
 * (with THREE.Color instances). Returns a new object — does not
 * mutate the input. Also returns mappingCurves if present.
 *
 * Pure function: new THREE.Color instances per call so the caller can
 * mutate without aliasing the serialized object.
 */
export function deserializeSettings(s: SerializedSettings): UserSettings & {
  activeScene?: string
  mappingCurves?: Record<MappingKey, MappingCurve>
} {
  return {
    // Numeric fields — straight copy.
    intensity: s.intensity,
    motion: s.motion,
    glow: s.glow,
    particleAmount: s.particleAmount,
    distortion: s.distortion,
    bassReaction: s.bassReaction,
    beatReaction: s.beatReaction,
    trebleReaction: s.trebleReaction,
    energyReaction: s.energyReaction,
    colorShift: s.colorShift,
    // Colors: rehydrate THREE.Color from `#rrggbb` string.
    primaryColor: new THREE.Color(s.primaryColor),
    secondaryColor: new THREE.Color(s.secondaryColor),
    backgroundColor: new THREE.Color(s.backgroundColor),
    activeScene: s.activeScene,
    mappingCurves: s.mappingCurves,
  }
}

/**
 * ============================================================================
 * LEVEL 2 ALGORITHM — base64url encoding for URL-safe transport
 * ============================================================================
 *
 * Standard base64 uses `A-Z a-z 0-9 + /` and pads with `=`. Three of
 * those characters are problematic in URL fragments:
 *   - `+` is decoded as a space by some servers / proxies.
 *   - `/` is a path separator — would create fake path segments.
 *   - `=` is a query-string delimiter — some parsers get confused.
 *
 * base64url (RFC 4648 §5) replaces them:
 *   - `+` → `-`
 *   - `/` → `_`
 *   - `=` padding → omitted entirely (the decoder can re-add it).
 *
 * This makes the encoded blob safe to paste into a URL hash, a query
 * string, or any URL component. Decoders reverse the substitutions
 * before calling atob.
 *
 * WHY use `unescape(encodeURIComponent(str))` (not `str` directly):
 *   btoa is a *Latin-1* encoder — it throws InvalidCharacterError on
 *   any code point above 0xff. The serialized JSON we pass in is plain
 *   ASCII (numbers + hex + `{}:,[]"`), so we don't *strictly* need
 *   UTF-8 handling here. But the round-trip with `decodeURIComponent(
 *   escape(atob(...)))` is the standard cross-browser pattern that's
 *   safe for any future content (e.g. if preset names ever get
 *   embedded). It's a few extra cycles per share — negligible.
 *
 * WHY the Node Buffer fallback: this module is imported by both client
 *   and server paths (the store does SSR-guarded reads). The client
 *   path uses btoa/atob; in Node (for tests or for Next.js server
 *   components that import the module graph), btoa is undefined and
 *   we fall back to Buffer. The output bytes are identical either way.
 * ============================================================================
 */
function base64UrlEncode(str: string): string {
  // btoa is available in browsers; in Node we'd use Buffer. This
  // module is browser-only (settings live in the React UI), but the
  // fallback keeps it importable from server contexts without crashing.
  const b64 = typeof btoa !== 'undefined'
    ? btoa(unescape(encodeURIComponent(str)))
    : Buffer.from(str, 'utf8').toString('base64')
  // URL-safe substitutions: + → -, / → _, strip `=` padding.
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Reverse of base64UrlEncode: URL-safe chars → standard base64, then
 * re-pad with `=` so atob accepts it, then decode.
 *
 * The padding calculation: base64 chunks are 4 chars wide. If the
 * input length isn't a multiple of 4, the missing chars are `=`.
 * `4 - (len % 4)` gives the number of `=` to append (0, 2, or 4 —
 * 4 only happens for empty input, which we never reach).
 */
function base64UrlDecode(str: string): string {
  // Reverse URL-safe substitutions: - → +, _ → /.
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  // Re-add padding — atob requires length % 4 === 0.
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const full = b64 + pad
  // Decode — atob in browsers, Buffer in Node (mirror of the encoder).
  if (typeof atob !== 'undefined') {
    return decodeURIComponent(escape(atob(full)))
  }
  return Buffer.from(full, 'base64').toString('utf8')
}

/**
 * Encode the current settings into a URL hash string like
 * `#preset=eyJ2IjoxLCJpbnRlbnNpdHkiOjEuMH0`.
 *
 * Pipeline: serialize → JSON.stringify → base64url-encode → prefix with
 * `#preset=`. The output is safe to assign to `window.location.hash`
 * or to append to a URL string.
 */
export function encodeSettingsToHash(
  settings: UserSettings,
  activeScene?: string,
  mappingCurves?: Record<MappingKey, MappingCurve>
): string {
  const serialized = serializeSettings(settings, activeScene, mappingCurves)
  const json = JSON.stringify(serialized)
  return `#${HASH_KEY}=${base64UrlEncode(json)}`
}

/**
 * Generate the full shareable URL for the current settings.
 *
 * WHY use `origin + pathname` (not `location.href`): location.href
 *   already includes any current hash, so we'd be appending a second
 *   `#preset=...` after the existing one. By explicitly rebuilding
 *   from origin + pathname, we always get a clean URL.
 *
 * Returns empty string in SSR — the caller should guard against that
 * (only call from a client component, or wrap in useEffect).
 */
export function buildShareUrl(
  settings: UserSettings,
  activeScene?: string,
  mappingCurves?: Record<MappingKey, MappingCurve>
): string {
  if (typeof window === 'undefined') return ''
  const hash = encodeSettingsToHash(settings, activeScene, mappingCurves)
  return window.location.origin + window.location.pathname + hash
}

/**
 * Read + decode any preset from the current URL hash. Returns null
 * if no preset is present or decoding fails.
 *
 * WHY return null on any failure: the caller (store on-mount) treats
 *   null as "no shared preset, use DEFAULT_SETTINGS". Throwing would
 *   crash the app on a malformed URL — null is the safe degraded state.
 *
 * WHY two shape checks after JSON.parse: defense in depth. A malicious
 *   or corrupted URL could contain valid base64 that decodes to valid
 *   JSON with the wrong shape. We check the version stamp first (reject
 *   unknown schemas), then sanity-check that `intensity` is a number
 *   (cheap proxy for "the JSON looks like a SerializedSettings"). A
 *   fully-typed validation would walk every field — overkill for a
 *   preset URL.
 */
export function readSettingsFromHash(): SerializedSettings | null {
  if (typeof window === 'undefined') return null
  const hash = window.location.hash
  // Quick reject if the hash doesn't start with our key prefix.
  if (!hash || !hash.startsWith(`#${HASH_KEY}=`)) return null
  // Slice off the `#preset=` prefix to get the bare base64url blob.
  const blob = hash.slice(`#${HASH_KEY}=`.length)
  try {
    // base64url-decode → JSON string → parse to object.
    const json = base64UrlDecode(blob)
    const parsed = JSON.parse(json) as SerializedSettings
    // Version check — must match exactly. Unknown versions are
    // treated as "not our data" and rejected → null.
    if (parsed.v !== VERSION) return null
    // Shape check — `intensity` is a required number. If it's missing
    // or wrong type, this isn't a valid SerializedSettings — reject.
    if (typeof parsed.intensity !== 'number') return null
    return parsed
  } catch {
    // base64 decode error, JSON parse error, etc. — degrade to null.
    return null
  }
}

/**
 * Remove the preset hash from the URL (so a refresh doesn't re-apply
 * a stale preset). Uses history.replaceState to avoid a navigation.
 *
 * WHY replaceState (not `location.hash = ''`): setting `location.hash`
 *   to empty still creates a History entry (the back button would go
 *   "back to the URL with the hash" — confusing). replaceState mutates
 *   the current entry in place: no history pollution, no navigation.
 *
 * Called after the store applies a shared preset, so a refresh of the
 * page boots with DEFAULT_SETTINGS (or the user's localStorage preset)
 * rather than re-applying the URL's snapshot.
 */
export function clearSettingsHash(): void {
  if (typeof window === 'undefined') return
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }
}
