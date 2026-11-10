import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { MapPicker } from '@/components/map-picker'
import { PlanExplorer } from '@/components/plan-explorer'
import { type AdrDocument } from '@/lib/adr'
import { parseBoundedAdr } from './adr-guard.ts'
import { createPlanLocation, PlanLocationContext, PortalContainerContext } from './bb-host-adapter.ts'
import { toReport, type Report } from '@/lib/plan'

import '@/app/globals.css'
import './shell.css'

export type MapEntry = { id: string; name: string; path: string }
export type ReadMaps = () => Promise<MapEntry[]>
export type ReadMap = (mapId: string) => Promise<string>
type Revision = { text: string; document: AdrDocument; report: Report }

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

function useHostDark(): boolean {
  const [isDark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(function followHostTheme() {
    const root = document.documentElement
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')))
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => observer.disconnect()
  }, [])

  return isDark
}

function usePluginPortal(pluginId: string): HTMLElement | null {
  const [container, setContainer] = useState<HTMLElement | null>(null)

  useEffect(
    function mountPortalRoot() {
      const element = document.createElement('div')
      element.className = 'plan-map-root'
      element.setAttribute('data-bb-plugin-root', '')
      element.setAttribute('data-bb-plugin', pluginId)
      document.body.append(element)
      setContainer(element)

      return () => element.remove()
    },
    [pluginId],
  )

  return container
}

type Props = {
  pluginId: string
  readMaps: ReadMaps
  readMap: ReadMap
  projectId: string
  emptyHint: string
  mapsVersion?: number
  emptyActions?: ReactNode
  banner?: ReactNode
}

export function PlanMapView({ pluginId, projectId, readMaps, readMap, emptyHint, mapsVersion = 0, emptyActions, banner }: Props) {
  const dark = useHostDark()
  const portal = usePluginPortal(pluginId)
  const [maps, setMaps] = useState<MapEntry[]>([])
  const [isListed, setListed] = useState(false)
  const [mapId, setMapId] = useState('')
  const [loaded, setLoaded] = useState<Revision | null>(null)
  const [pending, setPending] = useState<Revision | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const displayed = useRef('')
  const activeMap = useRef('')
  const generation = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const wasEmpty = useRef(false)

  const readRevision = useCallback(
    async (id: string) => {
      const request = ++generation.current
      setChecking(true)
      try {
        const text = await readMap(id)
        if (request !== generation.current || activeMap.current !== id) return
        if (text === displayed.current) {
          setError('')
          return
        }
        const document = parseBoundedAdr(text)
        const revision = { text, document, report: toReport(document) }
        if (!displayed.current) {
          displayed.current = text
          setLoaded(revision)
          setPending(null)
        } else setPending(revision)
        setError('')
      } catch (reason) {
        if (request === generation.current) setError(errorText(reason))
      } finally {
        if (request === generation.current) {
          setLoading(false)
          setChecking(false)
        }
      }
    },
    [readMap],
  )

  const chooseMap = useCallback(
    (id: string) => {
      activeMap.current = id
      displayed.current = ''
      setLoaded(null)
      setPending(null)
      setError('')
      setLoading(Boolean(id))
      setMapId(id)
      if (id) void readRevision(id)
    },
    [readRevision],
  )

  useEffect(
    function readBoundMaps() {
      let isCurrent = true
      readMaps().then(
        (entries) => {
          if (!isCurrent) return
          setMaps(entries)
          setListed(true)
          const first = entries[0]
          if (first && !activeMap.current) chooseMap(first.id)
          else if (!first) setLoading(false)
        },
        (reason) => {
          if (!isCurrent) return
          setError(errorText(reason))
          setLoading(false)
        },
      )

      return () => {
        isCurrent = false
      }
    },
    [readMaps, chooseMap, mapsVersion],
  )

  const reportId = loaded?.report.id
  const location = useMemo(
    () => createPlanLocation({ pluginId, scope: reportId ? `${projectId}:${mapId}` : undefined }),
    [pluginId, projectId, mapId, reportId],
  )
  const entry = maps.find((map) => map.id === mapId)
  const hasNoMaps = isListed && maps.length === 0

  useEffect(
    function trackEmptyState() {
      if (hasNoMaps) wasEmpty.current = true
    },
    [hasNoMaps],
  )

  useEffect(
    function focusFirstBoundMap() {
      const root = rootRef.current
      if (!loaded || !wasEmpty.current || !root) return
      wasEmpty.current = false
      const active = document.activeElement
      if (active && active !== document.body && !root.contains(active)) return
      root.querySelector<HTMLElement>('.app-header .map-picker-trigger')?.focus()
    },
    [loaded],
  )

  return (
    <PortalContainerContext value={portal}>
      <div ref={rootRef} className="plan-map-root min-h-0" data-plan-map-port="">
        <div className="viewer-frame">
          <header className="app-header">
            <span className="product-name">Plan Map</span>
            <span className="location-separator" aria-hidden="true">
              /
            </span>
            <h1 className="sr-only">{loaded?.report.title ?? 'Plan Map'}</h1>
            {hasNoMaps ? (
              <span className="map-picker-trigger" data-no-map="">
                No plan bound
              </span>
            ) : (
              <MapPicker maps={maps} mapId={mapId} title={loaded?.report.title} onSelect={chooseMap} />
            )}
            <div className="header-actions">
              <span className="snapshot-label">
                {loaded ? `Updated ${loaded.report.snapshotDate}` : 'Local · read-only'}
              </span>
              <button
                className="theme-toggle"
                aria-label="Check for a newer revision"
                title="Check for a newer revision"
                disabled={!mapId || checking}
                onClick={() => void readRevision(mapId)}
              >
                <RefreshCw size={17} />
              </button>
            </div>
          </header>
          {banner}
          {pending && (
            <output className="revision-banner">
              <span>A new ADR revision is available.</span>
              <button
                onClick={() => {
                  displayed.current = pending.text
                  setLoaded(pending)
                  setPending(null)
                }}
              >
                Load update
              </button>
            </output>
          )}
          {error && (
            <div className="source-error" role="alert">
              <b>{loaded ? 'Keeping the last valid map.' : 'Unable to load the map.'}</b>
              <pre>{error}</pre>
            </div>
          )}
          <div className="viewer-area">
            {loaded ? (
              <PlanLocationContext value={location}>
                <PlanExplorer
                  key={loaded.report.id + mapId}
                  report={loaded.report}
                  dark={dark}
                  sourcePath={entry?.path}
                />
              </PlanLocationContext>
            ) : (
              <main className="empty-map">
                <h1>{loading ? 'Reading your ADR…' : 'One map for the whole feature'}</h1>
                <p>{loading ? 'Checking the plan format and its dependencies.' : emptyHint}</p>
                {hasNoMaps && !loading ? emptyActions : null}
                <p>
                  The ADR stays in its project. This viewer reads its plan, decisions, evidence and
                  changes.
                </p>
              </main>
            )}
          </div>
        </div>
      </div>
    </PortalContainerContext>
  )
}
