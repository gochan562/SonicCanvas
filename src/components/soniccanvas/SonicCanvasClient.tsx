'use client'

import dynamic from 'next/dynamic'

/**
 * SonicCanvasClient
 *
 * Client-side wrapper that dynamically imports the SonicCanvas component
 * with `ssr: false`. This prevents server-side rendering of the Radix UI
 * components inside SonicCanvas, which generate IDs via useId that
 * differ between server and client, which causes hydration mismatches.
 *
 * Since SonicCanvas is a fully client-side app (WebGL, Web Audio API,
 * browser-only APIs), there's no benefit to SSR anyway.
 *
 * A loading fallback is shown while the dynamic import resolves.
 */
const SonicCanvas = dynamic(
  () => import('./SonicCanvas').then((m) => m.SonicCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen items-center justify-center bg-[#05030d] text-white/40">
        <div className="text-sm">Loading SonicCanvas…</div>
      </div>
    ),
  }
)

export function SonicCanvasClient() {
  return <SonicCanvas />
}
