import { createContext, createRef, use, type RefObject } from 'react'

export type PlanLocation = {
  url: () => URL
  push: (next: string | URL) => void
  subscribe: (listener: () => void) => () => void
  contains: (target: EventTarget | null) => boolean
  reference: (sourcePath?: string) => string
  storageKey: (name: string) => string
  isAtMost: (width: number) => boolean
  observeWidth: (listener: () => void) => () => void
  rootRef: RefObject<HTMLDivElement | null>
}

export type PlanLocationOptions = {
  pluginId?: string
  scope?: string
}

const ORIGIN = 'https://plan-map.invalid/'
const MAX_SAVED_VIEW = 2_000

function readSavedView(key: string): string {
  try {
    const saved = localStorage.getItem(key)
    if (saved === null || saved.length > MAX_SAVED_VIEW) return ''

    return saved.startsWith('?') || saved.startsWith('#') ? saved : ''
  } catch {
    return ''
  }
}

function saveView(key: string, view: string) {
  try {
    localStorage.setItem(key, view)
  } catch {
    return
  }
}

export function createPlanLocation({ pluginId = 'plan-map', scope }: PlanLocationOptions = {}): PlanLocation {
  const storageKey = (name: string) => `${pluginId}:${name}`
  const viewKey = scope ? storageKey(`view:${scope}`) : null
  let current = new URL(viewKey ? readSavedView(viewKey) : '', ORIGIN)
  const listeners = new Set<() => void>()
  const rootRef = createRef<HTMLDivElement>()
  const tabWidth = () => {
    const tab = rootRef.current?.closest<HTMLElement>('[data-plan-map-port]')

    return tab?.clientWidth || window.innerWidth
  }

  return {
    url: () => new URL(current),
    push: (next) => {
      current = new URL(next, current)
      if (viewKey) saveView(viewKey, `${current.search}${current.hash}`)
    },
    subscribe: (listener) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    contains: (target) => target instanceof Node && Boolean(rootRef.current?.contains(target)),
    reference: (sourcePath) => `${sourcePath ?? 'ADR'}${current.search}${current.hash}`,
    storageKey,
    isAtMost: (width) => tabWidth() <= width,
    observeWidth: (listener) => {
      const tab = rootRef.current?.closest<HTMLElement>('[data-plan-map-port]')
      listener()
      if (!tab) return () => undefined
      const observer = new ResizeObserver(listener)
      observer.observe(tab)

      return () => observer.disconnect()
    },
    rootRef,
  }
}

export const PlanLocationContext = createContext<PlanLocation>(createPlanLocation())

export function usePlanLocation(): PlanLocation {
  return use(PlanLocationContext)
}

export const PortalContainerContext = createContext<HTMLElement | null>(null)

export function usePortalContainer(): HTMLElement | undefined {
  return use(PortalContainerContext) ?? undefined
}
