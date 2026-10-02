"use client"

import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider duration={4000} swipeDirection="right">
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props} className="border-white/15 bg-[#0a0512]/95 text-white backdrop-blur-md">
            <div className="grid gap-1">
              {title && <ToastTitle className="text-sm font-medium text-white">{title}</ToastTitle>}
              {description && (
                <ToastDescription className="text-xs text-white/60">{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose className="border-white/20 text-white/50 hover:text-white" />
          </Toast>
        )
      })}
      <ToastViewport className="fixed bottom-4 right-4 flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-[380px]" />
    </ToastProvider>
  )
}