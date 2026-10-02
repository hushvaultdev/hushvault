import { useEffect, useRef } from 'react'

/**
 * Moves focus into a panel when it opens and puts it back on the element that had it
 * (normally the button that opened the panel) when it closes. Attach the returned ref to the
 * panel and give the panel tabIndex={-1}.
 */
export function useFocusReturn<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus()
    return () => {
      if (previous && previous.isConnected) previous.focus()
    }
  }, [open])
  return ref
}
