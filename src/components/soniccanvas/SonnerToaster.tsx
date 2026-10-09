'use client'

import { Toaster } from 'sonner'

/**
 * SonnerToaster
 *
 * Client wrapper for the Sonner Toaster (spec §46 — toast notifications).
 * Must be a client component because `sonner` uses React hooks internally.
 * Imported into the root layout (a server component) so it mounts once
 * at the app root.
 *
 * Style: dark translucent background, a bit of white border, positioned bottom-right.
 */
export function SonnerToaster() {
  return (
    <Toaster
      position="bottom-right"
      theme="dark"
      richColors={false}
      closeButton
      toastOptions={{
        style: {
          background: 'rgba(10, 5, 18, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          color: '#fff',
          borderRadius: '10px',
          fontSize: '13px',
          backdropFilter: 'blur(12px)',
        },
        classNames: {
          title: 'text-white font-medium',
          description: 'text-white/60',
        },
      }}
    />
  )
}
