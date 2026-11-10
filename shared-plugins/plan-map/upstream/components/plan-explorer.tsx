'use client'

import { Popover } from '@base-ui/react/popover'
import { Tabs } from '@base-ui/react/tabs'
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  useUpdateNodeInternals,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Columns3,
  FileText,
  Focus,
  GitBranch,
  Info,
  Maximize,
  Minus,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from 'lucide-react'
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

import { BlockerDetails, BlockerPreview } from '@/components/plan-blocker'
import { PlanBoard } from '@/components/plan-board'
import { DependencyDetails } from '@/components/plan-dependency'
import { RoutedEdge, type PlanEdge } from '@/components/plan-edge'
import { PlanList } from '@/components/plan-list'
import { PlanPanelDivider, usePlanPanelLayout } from '@/components/plan-panel-layout'
import { PanelSearch, StatusMark, TicketReference } from '@/components/plan-parts'
import { Button } from '@/components/ui/button'
import { SelectMenu } from '@/components/ui/select-menu'
import { layoutGraph, type GraphPort } from '@/lib/graph-layout'
import {
  createPlanModel,
  statusLabels,
  counts,
  type PlanItem,
  type Status,
  type PlanChange,
  type Report,
  type PlanModel,
} from '@/lib/plan'
import { searchPlan } from '@/lib/plan-search'
import {
  dependencyDetails,
  planViewUrl,
  readPlanView,
  searchResultView,
  visiblePlanItems,
  workstreamConnections,
  workstreamLinks,
  type PlanView,
} from '@/lib/plan-view'
import { usePlanLocation, usePortalContainer } from '@/lib/host'
import { cn } from '@/lib/utils'

import '@xyflow/react/dist/style.css'

type Selection =
  | { kind: 'item' | 'group' | 'change' | 'dependency'; id: string }
  | { kind: 'recap' }
type View = PlanView['view']
type Filter = PlanView['filter']
type GraphData = {
  kind: 'item' | 'group'
  id: string
  title: string
  ports: GraphPort[]
  onInspect?: () => void
}
type GraphNode = Node<GraphData, 'plan'>
const PlanContext = createContext<PlanModel | null>(null)
const usePlan = () => {
  const model = useContext(PlanContext)
  if (!model) throw new Error('Plan context is missing.')
  return model
}

const motionDuration = (duration = 200) =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : duration
const shortDate = (date: string) =>
  new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  })

function PlanComparison({
  item,
  onSelectItem,
  onOpenChange,
}: {
  item: PlanItem
  onSelectItem: (id: string) => void
  onOpenChange: (id: string) => void
}) {
  const { itemById, changesFor } = usePlan()
  const original = item.original
  const originalNeeds = original?.needs
  const isAdded = item.origin === 'added'
  const isParked = item.status === 'dropped'
  const recordedChanges = changesFor(item.id)
    .filter((change) => ['accepted', 'recorded'].includes(change.status))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  const latestChange = recordedChanges[0]
  const addedNeeds = originalNeeds
    ? item.needs.filter((id) => !originalNeeds.includes(id))
    : []
  const removedNeeds = originalNeeds?.filter((id) => !item.needs.includes(id)) ?? []
  const sameWording = original?.title === item.title
  const sameNeeds = Boolean(originalNeeds) && !addedNeeds.length && !removedNeeds.length
  const nameStep = (id: string) => (
    <button key={id} className="comparison-step-link" onClick={() => onSelectItem(id)}>
      {itemById[id]?.shortTitle ?? id}
    </button>
  )
  return (
    <section
      className="detail-section plan-comparison"
      aria-label="Original plan compared with now"
    >
      <h3>What changed since the plan?</h3>
      <dl className="plan-before-after">
        <div>
          <dt>Originally</dt>
          <dd>
            {isAdded
              ? 'This step was not listed in the original plan.'
              : (original?.title ?? 'The original wording was not recorded.')}
          </dd>
        </div>
        <div>
          <dt>Now</dt>
          <dd>
            {isParked ? (
              <>
                <strong>Parked.</strong> This step is no longer part of the active plan.
              </>
            ) : (
              <>
                {isAdded && <strong>Added to the plan. </strong>}
                {item.title}
              </>
            )}
          </dd>
          {addedNeeds.length > 0 && (
            <dd className="comparison-dependencies">
              <span>Now waits for:</span>
              {addedNeeds.map(nameStep)}
            </dd>
          )}
          {removedNeeds.length > 0 && (
            <dd className="comparison-dependencies">
              <span>No longer waits for:</span>
              {removedNeeds.map(nameStep)}
            </dd>
          )}
        </div>
      </dl>
      {!isAdded && !isParked && sameWording && sameNeeds && (
        <p className="muted comparison-note">
          The wording and prerequisites are unchanged. A separate update was recorded
          below.
        </p>
      )}
      {!isAdded && !isParked && original?.title && !sameWording && sameNeeds && (
        <p className="muted comparison-note">
          The description changed. It still waits for the same steps.
        </p>
      )}
      {!isAdded && original?.needs === null && (
        <p className="muted comparison-note">
          The original prerequisites were not recorded, so we cannot compare them.
        </p>
      )}
      <div className="comparison-reason">
        <h4>{latestChange ? 'Recorded change and reason' : 'Why'}</h4>
        {latestChange ? (
          <>
            <p className="comparison-summary">{latestChange.what}</p>
            <p>{latestChange.why}</p>
            <button className="text-button" onClick={() => onOpenChange(latestChange.id)}>
              Read{' '}
              {recordedChanges.length > 1
                ? 'the latest change record'
                : 'the change record'}
              <ArrowRight size={13} />
            </button>
            {latestChange.status === 'recorded' && (
              <small className="source-label">
                Recorded history; approval is not established by this entry.
              </small>
            )}
            {recordedChanges.length > 1 && (
              <small className="source-label">
                Earlier records are in Change history below.
              </small>
            )}
          </>
        ) : (
          <p className="muted">
            No reason has been recorded for this difference. Proposed or rejected changes
            are not treated as its explanation.
          </p>
        )}
      </div>
    </section>
  )
}

function MapNode({ data, selected }: NodeProps<GraphNode>) {
  const model = usePlan()
  const { itemById, groupById } = model
  const item = data.kind === 'item' ? itemById[data.id] : null
  const group = data.kind === 'group' ? groupById[data.id] : null
  const groupItems = group?.ids.map((id) => itemById[id]) ?? []
  const summary = counts(groupItems)
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(data.id)
  }, [data.id, data.ports, updateNodeInternals])
  const status: Status =
    item?.status ??
    (groupItems.length > 0 && summary.parked === groupItems.length
      ? 'dropped'
      : groupItems.length > 0 && summary.done === groupItems.length
        ? 'done'
        : summary.blocked > 0
          ? 'blocked'
          : summary.active > 0
            ? 'in_progress'
            : 'todo')
  return (
    <div
      className={cn(
        'map-node',
        selected && 'is-selected',
        status === 'dropped' && 'is-parked',
      )}
      data-status={status}
    >
      {data.ports.map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type={port.type}
          position={
            {
              top: Position.Top,
              right: Position.Right,
              bottom: Position.Bottom,
              left: Position.Left,
            }[port.side]
          }
          isConnectable={false}
          style={{
            left: port.x,
            top: port.y,
            right: 'auto',
            bottom: 'auto',
            transform: 'translate(-50%, -50%)',
          }}
        />
      ))}
      {item ? (
        <>
          <div className="node-meta">
            <span>{item.id}</span>
            <StatusMark status={item.status} label />
          </div>
          <div className="node-title">{item.shortTitle}</div>
          {item.status === 'blocked' && data.onInspect && (
            <BlockerPreview item={item} model={model} onInspect={data.onInspect} />
          )}
          <div className="node-footer">
            {item.tickets.length ? (
              <span className="node-tickets">
                <TicketReference ticket={item.tickets[0]} />
                {item.tickets.length > 1 && (
                  <span title="Additional tickets are listed in the step details">
                    +{item.tickets.length - 1}
                  </span>
                )}
              </span>
            ) : (
              <span>{groupById[item.groupId].title}</span>
            )}
            {item.origin === 'added' ? (
              <span className="delta-label">
                <Plus size={11} />
                Added
              </span>
            ) : item.changed ? (
              <span className="delta-label">
                <GitBranch size={11} />
                Changed
              </span>
            ) : item.status === 'dropped' ? (
              <span>Parked</span>
            ) : null}
          </div>
        </>
      ) : group ? (
        <>
          <div className="node-meta">
            <span>
              {groupItems.length} {groupItems.length === 1 ? 'step' : 'steps'}
            </span>
            <StatusMark status={status} label />
          </div>
          <div className="node-title">{group.title}</div>
          {summary.blocked > 0 && (
            <button
              className="node-blocked-count text-button nodrag nopan"
              onClick={(event) => {
                event.stopPropagation()
                data.onInspect?.()
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {summary.blocked} blocked {summary.blocked === 1 ? 'step' : 'steps'}{' '}
              <ArrowRight size={12} />
            </button>
          )}
          <div
            className="group-progress"
            aria-label={`${summary.done} done, ${summary.active} in progress, ${summary.todo} to do, ${summary.blocked} blocked, ${summary.parked} parked`}
          >
            {groupItems.map((step) => (
              <span key={step.id} className={`progress-${step.status}`} />
            ))}
          </div>
          <div className="node-footer">
            <span>
              {summary.done
                ? `${summary.done} done`
                : summary.active
                  ? `${summary.active} in progress`
                  : status === 'dropped'
                    ? 'All parked'
                    : 'Work remaining'}{' '}
              · {groupItems.length} total
            </span>
            <ArrowUpRight size={14} />
          </div>
        </>
      ) : null}
    </div>
  )
}
const nodeTypes = { plan: MapNode }
const edgeTypes = { plan: RoutedEdge }

function buildGraph(
  view: View,
  filter: Filter,
  scope: string | null,
  focus: string | null,
  model: PlanModel,
  nodeHeights: Record<string, number>,
  nodeWidth: number,
) {
  const { report } = model
  const isOverview = view === 'overview'
  const heightFor = (id: string) => nodeHeights[`${view}:${nodeWidth}:${id}`] ?? 112
  const items = visiblePlanItems(model, { view, filter, scope, focus })
  const ids = new Set(items.map((item) => item.id))
  const cards = isOverview
    ? report.groups.map((group) => ({
        id: group.id,
        kind: 'group' as const,
        title: group.title,
        ariaLabel: `${group.title}, ${group.ids.length} ${group.ids.length === 1 ? 'step' : 'steps'}. Select to inspect.`,
      }))
    : items.map((item) => ({
        id: item.id,
        kind: 'item' as const,
        title: item.shortTitle,
        ariaLabel: `${item.id}: ${item.shortTitle}, ${statusLabels[item.status]}. Select to inspect.`,
      }))
  const connections = isOverview
    ? workstreamLinks(model).map((link) => ({
        ...link,
        className: undefined,
      }))
    : items.flatMap((item) =>
        item.needs
          .filter((id) => ids.has(id))
          .map((id) => ({
            id: `${id}:${item.id}`,
            source: id,
            target: item.id,
            className: item.status === 'dropped' ? 'parked-edge' : undefined,
          })),
      )
  const layout = layoutGraph(
    cards.map((card) => ({ id: card.id, width: nodeWidth, height: heightFor(card.id) })),
    connections,
    {
      rankdir: focus && !isOverview ? 'LR' : 'TB',
      nodesep: nodeWidth < 240 ? 32 : 56,
      ranksep: isOverview ? 80 : 56,
    },
  )
  const nodes: GraphNode[] = cards.map((card) => ({
    id: card.id,
    type: 'plan',
    width: nodeWidth,
    measured: {
      width: nodeWidth,
      height: nodeHeights[`${view}:${nodeWidth}:${card.id}`],
    },
    ariaRole: 'button',
    ariaLabel: card.ariaLabel,
    position: layout.nodes[card.id].position,
    data: {
      kind: card.kind,
      id: card.id,
      title: card.title,
      ports: layout.nodes[card.id].ports,
    },
  }))
  const edges: PlanEdge[] = layout.links.map((link, index) => {
    const dependencyId = `${isOverview ? 'workstream' : 'step'}:${link.source}:${link.target}`
    const description = dependencyDetails(model, dependencyId)!.summary
    return {
      id: link.id,
      source: link.source,
      target: link.target,
      sourceHandle: link.sourceHandle,
      targetHandle: link.targetHandle,
      type: 'plan',
      className: connections[index].className,
      markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge)' },
      ariaRole: 'button',
      ariaLabel: `${description}. Select to inspect dependency.`,
      data: { path: link.path, description, dependencyId },
    }
  })
  return { nodes, edges }
}

function Explorer({ dark, sourcePath }: { dark: boolean; sourcePath?: string }) {
  const model = usePlan()
  const location = usePlanLocation()
  const portal = usePortalContainer()
  const { report, itemById, groupById, dependants, changesFor } = model
  const [mapView, setMapView] = useState(() => readPlanView(location.url(), model))
  const [diagramView, setDiagramView] = useState<PlanView>(() =>
    mapView.view === 'board' ? { ...mapView, view: 'steps' } : mapView,
  )
  const { view, filter, scope, focus } = mapView
  const isBoard = view === 'board'
  const [selection, setSelection] = useState<Selection>({ kind: 'recap' })
  const { layout: panelLayout, setLayout: setPanelLayout } = usePlanPanelLayout()
  const [navTab, setNavTab] = useState<'plan' | 'details' | 'changes' | 'source'>('plan')
  const [query, setQuery] = useState('')
  const [searchTarget, setSearchTarget] = useState<string | null>(null)
  const [changeQuery, setChangeQuery] = useState('')
  const [zoom, setZoom] = useState(1)
  const [notice, setNotice] = useState('')
  const [ready, setReady] = useState(false)
  const [isCompact, setIsCompact] = useState(
    () => location.isAtMost(760),
  )
  const nodeWidth = isCompact ? 156 : 240
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({})
  const workspaceRef = useRef<HTMLDivElement>(null)
  const panelToggleRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const changesRef = useRef<HTMLDivElement>(null)
  const stepsTabRef = useRef<HTMLElement>(null)
  const flowRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const framedGraphKey = useRef<string | null>(null)
  const { fitView, setViewport, setCenter, zoomIn, zoomOut } = useReactFlow<GraphNode>()
  const graph = useMemo(
    () =>
      buildGraph(
        diagramView.view,
        diagramView.filter,
        diagramView.scope,
        diagramView.focus,
        model,
        nodeHeights,
        nodeWidth,
      ),
    [diagramView, model, nodeHeights, nodeWidth],
  )
  const onNodesChange = useCallback(
    (changes: NodeChange<GraphNode>[]) => {
      setNodeHeights((current) =>
        changes.reduce((heights, change) => {
          if (change.type !== 'dimensions' || !change.dimensions?.height) return heights
          const key = `${diagramView.view}:${nodeWidth}:${change.id}`
          const height = change.dimensions.height
          return heights[key] === height ? heights : { ...heights, [key]: height }
        }, current),
      )
    },
    [diagramView.view, nodeWidth],
  )
  const layoutReady = graph.nodes.every(
    (node) => nodeHeights[`${diagramView.view}:${nodeWidth}:${node.id}`] !== undefined,
  )
  const graphKey = `${diagramView.view}:${diagramView.filter}:${diagramView.scope}:${diagramView.focus}:${nodeWidth}`
  const hasSearch = query.trim().length > 0
  const matches = useMemo(() => searchPlan(model, query), [model, query])
  const matchingIds = useMemo(() => new Set(matches.map((item) => item.id)), [matches])
  const matchingGroups = useMemo(
    () => new Set(matches.map((item) => item.groupId)),
    [matches],
  )
  const selectedId =
    selection.kind === 'item' || selection.kind === 'group' ? selection.id : null
  const selectedDependency =
    selection.kind === 'dependency' ? dependencyDetails(model, selection.id) : null
  const navigate = useCallback((next: Selection) => {
    setSelection(next)
    if (next.kind === 'change' || next.kind === 'recap') {
      setNavTab('details')
      requestAnimationFrame(() => {
        detailRef.current?.scrollTo({ top: 0 })
        if (location.isAtMost(1000))
          panelRef.current?.scrollIntoView({ block: 'start' })
        detailRef.current?.focus({ preventScroll: true })
      })
    }
    setNotice('')
    location.push(next.kind === 'recap' ? '#recap' : `#${next.kind}/${next.id}`)
  }, [location])
  const restoreLocation = useCallback(() => {
    setSearchTarget(null)
    const next = readPlanView(location.url(), model)
    setMapView(next)
    if (next.view !== 'board') setDiagramView(next)
    const [kind, id] = location.url().hash.slice(1).split('/')
    if (kind === 'item' && itemById[id]) {
      setSelection({ kind, id })
      setNavTab('details')
    } else if ((kind === 'group' || kind === 'workstream') && groupById[id]) {
      setSelection({ kind: 'group', id })
      setNavTab(kind === 'workstream' ? 'plan' : 'details')
    } else if (kind === 'change' && report.changes.some((change) => change.id === id)) {
      setSelection({ kind, id })
      setNavTab('details')
    } else if (kind === 'dependency' && dependencyDetails(model, id)) {
      setSelection({ kind, id })
      setNavTab('details')
    } else {
      setSelection({ kind: 'recap' })
      setNavTab(kind === 'recap' ? 'details' : 'plan')
    }
  }, [itemById, groupById, report.changes, model, location])
  useEffect(
    function syncCardWidth() {
      return location.observeWidth(() => setIsCompact(location.isAtMost(760)))
    },
    [location],
  )
  useEffect(() => location.subscribe(restoreLocation), [location, restoreLocation])
  const initialiseMap = () => {
    restoreLocation()
    setReady(true)
  }
  useEffect(
    function frameReadableGraph() {
      if (
        isBoard ||
        !ready ||
        !layoutReady ||
        (!searchTarget && framedGraphKey.current === graphKey)
      )
        return
      const container = flowRef.current
      const anchor =
        graph.nodes.find((node) => node.id === (searchTarget ?? focus)) ??
        graph.nodes.reduce<GraphNode | undefined>(
          (first, node) => (!first || node.position.y < first.position.y ? node : first),
          undefined,
        )
      if (!container || !anchor) return
      const duration = framedGraphKey.current === null ? 0 : motionDuration()
      framedGraphKey.current = graphKey
      void setViewport(
        {
          x: (container.clientWidth - nodeWidth) / 2 - anchor.position.x,
          y:
            (searchTarget || focus
              ? (container.clientHeight - (anchor.measured?.height ?? 112)) / 2
              : 24) - anchor.position.y,
          zoom: 1,
        },
        { duration },
      ).then(() => {
        if (searchTarget)
          setSearchTarget((target) => (target === searchTarget ? null : target))
      })
    },
    [
      isBoard,
      ready,
      layoutReady,
      graphKey,
      graph.nodes,
      focus,
      searchTarget,
      nodeWidth,
      setViewport,
    ],
  )
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!location.contains(event.target)) return
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[role="combobox"], [role="listbox"], [role="option"]')
      )
        return
      if (event.key === 'Escape' && navTab === 'details' && panelLayout.isVisible) {
        setNavTab('plan')
        requestAnimationFrame(() => stepsTabRef.current?.focus({ preventScroll: true }))
      }
      if (
        event.target instanceof HTMLElement &&
        (event.target.closest('input, textarea, select') ||
          event.target.isContentEditable)
      )
        return
      if (event.key === '/') {
        event.preventDefault()
        setNavTab('plan')
        setPanelLayout((current) => ({ ...current, isVisible: true }))
        requestAnimationFrame(() => searchRef.current?.focus())
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (!isBoard && event.key.toLowerCase() === 'f')
        void fitView({ padding: 0.18, duration: motionDuration() })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [fitView, setPanelLayout, navTab, panelLayout.isVisible, isBoard, location])

  const changeMapView = (next: PlanView, nextSelection?: Selection) => {
    setMapView(next)
    if (next.view !== 'board') setDiagramView(next)
    const url = planViewUrl(location.url(), next)
    if (nextSelection) {
      setSelection(nextSelection)
      url.hash =
        nextSelection.kind === 'recap'
          ? 'recap'
          : `${nextSelection.kind === 'group' ? 'workstream' : nextSelection.kind}/${nextSelection.id}`
    }
    location.push(url)
  }
  const changeView = (next: View) => {
    if (next === view) return
    changeMapView(
      next === 'overview'
        ? { view: next, scope: null, focus: null, filter: 'all' }
        : { ...mapView, view: next },
    )
  }
  const chooseWorkstream = (id: string | null) => {
    const nextSelection =
      id && !(selection.kind === 'item' && itemById[selection.id]?.groupId === id)
        ? { kind: 'group' as const, id }
        : selection
    changeMapView(
      { view: isBoard ? 'board' : 'steps', scope: id, focus: null, filter: 'all' },
      nextSelection,
    )
    setNavTab('plan')
    listRef.current?.scrollTo({ top: 0 })
    if (location.isAtMost(1000))
      canvasRef.current?.parentElement?.scrollIntoView({ block: 'start' })
  }
  const revealRegion = useCallback(
    (region: 'list' | 'record' | 'changes') => {
      setPanelLayout((current) => ({ ...current, isVisible: true }))
      setNavTab(
        region === 'record' ? 'details' : region === 'changes' ? 'changes' : 'plan',
      )
      requestAnimationFrame(() => {
        const element =
          region === 'record'
            ? detailRef.current
            : region === 'changes'
              ? changesRef.current
              : listRef.current
        if (!element) return
        if (region !== 'list') element.scrollTo({ top: 0 })
        if (location.isAtMost(1000)) {
          panelRef.current?.scrollIntoView({ block: 'start' })
        }
        element.focus({ preventScroll: true })
      })
    },
    [setPanelLayout],
  )
  const inspectRecord = useCallback(
    (next: Selection) => {
      navigate(next)
      revealRegion('record')
    },
    [navigate, revealRegion],
  )
  const nodes = useMemo(
    () =>
      graph.nodes.map((node) => {
        const isMatch = (node.data.kind === 'group' ? matchingGroups : matchingIds).has(
          node.id,
        )
        return {
          ...node,
          className: cn(
            hasSearch && isMatch && 'is-search-match',
            hasSearch && !isMatch && 'is-search-muted',
          ),
          ariaLabel: `${node.ariaLabel}${hasSearch && isMatch ? ' Search match.' : ''}`,
          selected: node.id === selectedId,
          data: {
            ...node.data,
            onInspect: () => inspectRecord({ kind: node.data.kind, id: node.id }),
          },
        }
      }),
    [graph.nodes, selectedId, inspectRecord, hasSearch, matchingIds, matchingGroups],
  )
  const edges = useMemo(
    () =>
      graph.edges.map((edge) => {
        const isSelected = edge.data?.dependencyId === selectedDependency?.id
        const isRelated =
          isSelected || edge.source === selectedId || edge.target === selectedId
        return {
          ...edge,
          selected: isSelected,
          className: cn(
            edge.className,
            isRelated && 'is-related',
            hasSearch &&
              !(view === 'overview' ? matchingGroups : matchingIds).has(edge.source) &&
              !(view === 'overview' ? matchingGroups : matchingIds).has(edge.target) &&
              'is-search-muted',
          ),
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isRelated ? 'var(--link)' : 'var(--edge)',
          },
        }
      }),
    [
      graph.edges,
      selectedId,
      selectedDependency?.id,
      hasSearch,
      view,
      matchingIds,
      matchingGroups,
    ],
  )
  const changeSection = (section: typeof navTab) => {
    setNavTab(section)
    setPanelLayout((current) => ({ ...current, isVisible: true }))
    if (location.isAtMost(1000))
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'start' }))
  }
  const hidePanel = () => {
    setPanelLayout((current) => ({ ...current, isVisible: false }))
    panelToggleRef.current?.focus({ preventScroll: true })
  }
  const selectItem = (id: string) => navigate({ kind: 'item', id })
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.reference(sourcePath))
      setNotice('ADR path and view copied')
    } catch {
      setNotice('Copy is unavailable here.')
    }
  }
  const openGroup = (id: string) => {
    navigate({ kind: 'group', id })
  }
  const visibleItems = visiblePlanItems(model, mapView)
  const activeGroup = scope ? groupById[scope] : null
  const connections = scope ? workstreamConnections(model, scope) : null
  const hasExternalConnections = Boolean(
    view !== 'overview' &&
    !focus &&
    connections &&
    (connections.incoming.length || connections.outgoing.length),
  )
  const searchResults = hasSearch ? matches : visibleItems
  const matchingNodeCount = graph.nodes.filter((node) =>
    (view === 'overview' ? matchingGroups : matchingIds).has(node.id),
  ).length
  const changeSearch = (value: string) => {
    setQuery(value)
    setNavTab('plan')
    setPanelLayout((current) => ({ ...current, isVisible: true }))
    listRef.current?.scrollTo({ top: 0 })
  }
  const showSearchResult = (id: string) => {
    changeMapView(searchResultView(model, mapView, id), { kind: 'item', id })
    setSearchTarget(id)
    if (location.isAtMost(1000))
      canvasRef.current?.parentElement?.scrollIntoView({ block: 'start' })
  }
  const summary = counts(report.items)
  const shownChanges = report.changes.filter((change) =>
    change.text.toLowerCase().includes(changeQuery.toLowerCase().trim()),
  )
  const selectedItem = selection.kind === 'item' ? itemById[selection.id] : null
  const selectedGroup = selection.kind === 'group' ? groupById[selection.id] : null
  const selectedConnections = selectedGroup
    ? workstreamConnections(model, selectedGroup.id)
    : null
  const selectedGroupChanges = selectedGroup
    ? report.changes.filter((change) =>
        change.itemIds.some((id) => selectedGroup.ids.includes(id)),
      )
    : []
  const selectedItemChanges = selectedItem ? changesFor(selectedItem.id) : []
  const selectedChange =
    selection.kind === 'change'
      ? report.changes.find((change) => change.id === selection.id)
      : null
  const selectedIndex = selectedItem
    ? visibleItems.findIndex((item) => item.id === selectedItem.id)
    : -1
  const itemLink = (item: PlanItem, showGroup = false) => (
    <button key={item.id} className="related-step" onClick={() => selectItem(item.id)}>
      <StatusMark status={item.status} />
      <span>
        <small>{item.id}</small>
        {item.shortTitle}
        {showGroup && <small>{groupById[item.groupId].title}</small>}
      </span>
      <ChevronRight size={15} />
    </button>
  )
  const changeCard = (change: PlanChange) => (
    <button
      key={change.id}
      className="change-preview"
      onClick={() => navigate({ kind: 'change', id: change.id })}
    >
      <span className="change-date">
        {change.id} · {shortDate(change.date)}
        <span className="recorded-tag">{change.status}</span>
      </span>
      <span>{change.what}</span>
      <span className="change-why">{change.why}</span>
    </button>
  )

  return (
    <div className={cn('explorer', dark && 'dark')} ref={location.rootRef}>
      <div className="document-navigation">
        <div className="plan-summary" aria-label="Plan status">
          <span>{summary.done} done</span>
          <span>{summary.active} in progress</span>
          {summary.blocked > 0 && <span>{summary.blocked} blocked</span>}
          <span>{summary.parked} parked</span>
        </div>
        <search className="plan-search" aria-label="Search this plan">
          <PanelSearch
            label="Search nodes and steps"
            value={query}
            onChange={changeSearch}
            inputRef={searchRef}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setQuery('')
              }
              if (event.key === 'Enter' && hasSearch && matches[0]) {
                event.preventDefault()
                showSearchResult(matches[0].id)
              }
            }}
          />
          {hasSearch && (
            <button
              className="text-button search-results-count"
              onClick={() => revealRegion('list')}
              aria-label="Show search results"
            >
              {matches.length} {matches.length === 1 ? 'step' : 'steps'}{' '}
              <ArrowDown size={13} />
            </button>
          )}
          <output className="sr-only">
            {hasSearch
              ? `${matches.length} matching ${matches.length === 1 ? 'step' : 'steps'} across all workstreams`
              : ''}
          </output>
        </search>
        <Button
          ref={panelToggleRef}
          className="panel-toggle"
          variant="ghost"
          size="icon"
          aria-label={
            panelLayout.isVisible ? 'Hide list and details' : 'Show list and details'
          }
          title={
            panelLayout.isVisible ? 'Hide list and details' : 'Show list and details'
          }
          aria-expanded={panelLayout.isVisible}
          aria-controls="plan-panel"
          onClick={() =>
            setPanelLayout((current) => ({ ...current, isVisible: !current.isVisible }))
          }
        >
          {panelLayout.isVisible ? <PanelRightClose /> : <PanelRightOpen />}
        </Button>
        <div className="mobile-jumps">
          <button
            onClick={() => {
              revealRegion('list')
            }}
          >
            List
          </button>
          <button
            onClick={() => {
              revealRegion('record')
            }}
          >
            Details
          </button>
        </div>
      </div>
      <div
        className={cn('workspace', !panelLayout.isVisible && 'is-panel-hidden')}
        ref={workspaceRef}
        style={{ '--plan-panel-width': `${panelLayout.width}%` } as CSSProperties}
      >
        <main
          className={cn('map-area', isBoard && 'is-board-view')}
          id="diagram"
          tabIndex={-1}
          aria-label={isBoard ? 'Interactive status board' : 'Interactive plan map'}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            if (
              event.target instanceof Element &&
              event.target.closest('a, button, input, select, textarea')
            )
              return
            const edgeElement =
              event.target instanceof Element
                ? event.target.closest('.react-flow__edge[data-id]')
                : null
            const edge = graph.edges.find(
              (candidate) => candidate.id === edgeElement?.getAttribute('data-id'),
            )
            if (edge?.data) {
              event.preventDefault()
              event.stopPropagation()
              inspectRecord({ kind: 'dependency', id: edge.data.dependencyId })
              return
            }
            const target =
              event.target instanceof HTMLElement
                ? event.target.closest<HTMLElement>('.react-flow__node[data-id]')
                : null
            const node = graph.nodes.find(
              (candidate) => candidate.id === target?.dataset.id,
            )
            if (!node) return
            event.preventDefault()
            event.stopPropagation()
            if (node.data.kind === 'item') selectItem(node.id)
            else openGroup(node.id)
          }}
        >
          <div className="map-toolbar">
            <h2 className="sr-only">{isBoard ? 'Status board' : 'Diagram'}</h2>
            <fieldset className="view-switch" aria-label="Map view">
              <button
                aria-pressed={view === 'overview'}
                onClick={() => changeView('overview')}
              >
                <Network size={14} />
                Overview
              </button>
              <button aria-pressed={view === 'steps'} onClick={() => changeView('steps')}>
                <GitBranch size={14} />
                Steps
              </button>
              <button aria-pressed={isBoard} onClick={() => changeView('board')}>
                <Columns3 size={14} /> Board
              </button>
            </fieldset>
            <div className="workstream-toolbar">
              <SelectMenu
                label="Workstream"
                className="workstream-picker"
                value={scope ?? ''}
                options={[
                  {
                    value: '',
                    label: 'All workstreams',
                    count: `${report.items.length} ${report.items.length === 1 ? 'step' : 'steps'}`,
                  },
                  ...report.groups.map((group) => ({
                    value: group.id,
                    label: group.title,
                    count: `${group.ids.length} ${group.ids.length === 1 ? 'step' : 'steps'}`,
                  })),
                ]}
                onValueChange={(id) => chooseWorkstream(id || null)}
              />
              {scope && (
                <button className="text-button" onClick={() => chooseWorkstream(null)}>
                  Full plan <X size={12} />
                </button>
              )}
              {view !== 'overview' && (
                <select
                  className="map-filter"
                  aria-label="Filter steps"
                  value={filter}
                  onChange={(event) => {
                    changeMapView({
                      ...mapView,
                      filter: event.target.value as Filter,
                      focus: null,
                    })
                  }}
                >
                  <option value="all">All steps</option>
                  <option value="active">In progress</option>
                  <option value="blocked">Blocked</option>
                  <option value="original">Original steps</option>
                  <option value="changed">Changed scope</option>
                </select>
              )}
            </div>
          </div>
          {(hasSearch ||
            focus ||
            hasExternalConnections ||
            (view !== 'overview' && filter !== 'all')) && (
            <div className="map-context">
              {hasSearch && (
                <span>
                  {isBoard
                    ? `${matches.length} matching ${matches.length === 1 ? 'step' : 'steps'} across all workstreams`
                    : `${matchingNodeCount} matching ${view === 'overview' ? 'workstream' : 'step'}${matchingNodeCount === 1 ? '' : 's'} in this diagram · ${matches.length} ${matches.length === 1 ? 'step' : 'steps'} in the plan`}
                </span>
              )}
              {focus && <span>{focus} and connected steps</span>}
              {!hasSearch && (focus || filter !== 'all') && (
                <span>
                  {visibleItems.length} of{' '}
                  {focus
                    ? report.items.length
                    : (activeGroup?.ids.length ?? report.items.length)}{' '}
                  steps
                  {filter === 'original' && ' · current reported status'}
                  {filter === 'changed' && ' · added, changed and parked work'}
                </span>
              )}
              {hasExternalConnections && connections && activeGroup && (
                <button
                  className="workstream-connections text-button"
                  onClick={() => {
                    openGroup(activeGroup.id)
                    revealRegion('record')
                  }}
                >
                  {connections.incoming.length}{' '}
                  {connections.incoming.length === 1 ? 'prerequisite' : 'prerequisites'} ·{' '}
                  {connections.outgoing.length}{' '}
                  {connections.outgoing.length === 1 ? 'dependant' : 'dependants'} in
                  other workstreams <ArrowRight size={13} />
                </button>
              )}
              {focus && (
                <button
                  className="text-button"
                  onClick={() =>
                    changeMapView({ ...mapView, focus: null, filter: 'all' })
                  }
                >
                  {activeGroup ? `Back to ${activeGroup.title}` : 'All steps'}
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          <div className="map-canvas" ref={canvasRef}>
            <div
              className={cn('flow-container', isBoard && 'is-inactive')}
              inert={isBoard}
              aria-hidden={isBoard}
              ref={flowRef}
            >
              {nodes.length === 0 && (
                <p className="empty-graph">
                  No steps match this filter.{' '}
                  <button
                    className="text-button"
                    onClick={() =>
                      changeMapView({ ...mapView, filter: 'all', focus: null })
                    }
                  >
                    Show all steps{activeGroup ? ' in this workstream' : ''}
                  </button>
                </p>
              )}
              <ReactFlow<GraphNode, PlanEdge>
                nodes={nodes}
                onNodesChange={onNodesChange}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={initialiseMap}
                onNodeClick={(_, node) =>
                  node.data.kind === 'item' ? selectItem(node.id) : openGroup(node.id)
                }
                onEdgeClick={(_, edge) => {
                  if (edge.data)
                    inspectRecord({ kind: 'dependency', id: edge.data.dependencyId })
                }}
                onMove={(_, viewport) => setZoom(viewport.zoom)}
                minZoom={0.2}
                maxZoom={1.6}
                nodesDraggable={false}
                nodesConnectable={false}
                edgesFocusable
                deleteKeyCode={null}
                panOnScroll
                zoomOnScroll={false}
                zoomOnPinch
                panOnDrag
                selectionOnDrag={false}
                colorMode={dark ? 'dark' : 'light'}
                ariaLabelConfig={{
                  'node.a11yDescription.default':
                    'Press Enter to inspect this step or workstream. Use the step list to move between steps.',
                  'edge.a11yDescription.default':
                    'Press Enter to see the prerequisite and the step that depends on it.',
                }}
              >
                {diagramView.view === 'steps' && (
                  <MiniMap
                    style={{ width: 130, height: 86 }}
                    pannable
                    zoomable
                    nodeColor="var(--minimap-node)"
                    maskColor="var(--minimap-mask)"
                    ariaLabel="Map overview. Drag to navigate."
                  />
                )}
              </ReactFlow>
            </div>
            <PlanBoard
              items={searchResults}
              model={model}
              selectedId={selectedId}
              hidden={!isBoard}
              onInspect={(id) => inspectRecord({ kind: 'item', id })}
            />
          </div>
          <footer
            className="canvas-toolbar"
            aria-label={isBoard ? 'Board controls' : 'Diagram controls'}
          >
            {isBoard ? (
              <span className="board-summary">
                {searchResults.length} {searchResults.length === 1 ? 'step' : 'steps'} ·
                scroll across for all statuses
              </span>
            ) : (
              <div className="map-controls">
                <button
                  aria-label="Zoom out"
                  title="Zoom out"
                  onClick={() => void zoomOut({ duration: motionDuration(150) })}
                >
                  <Minus size={16} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  aria-label="Zoom in"
                  title="Zoom in"
                  onClick={() => void zoomIn({ duration: motionDuration(150) })}
                >
                  <Plus size={16} />
                </button>
                <i />
                <button
                  aria-label="Fit entire map"
                  title="Fit entire map (F)"
                  onClick={() =>
                    void fitView({ padding: 0.18, duration: motionDuration() })
                  }
                >
                  <Maximize size={15} />
                </button>
                {selectedId && graph.nodes.some((node) => node.id === selectedId) && (
                  <button
                    aria-label="Centre selected item at readable size"
                    title="Centre selected item at 100%"
                    onClick={() => {
                      const node = graph.nodes.find(
                        (candidate) => candidate.id === selectedId,
                      )!
                      void setCenter(
                        node.position.x + nodeWidth / 2,
                        node.position.y + (node.measured?.height ?? 112) / 2,
                        {
                          zoom: 1,
                          duration: motionDuration(),
                        },
                      )
                    }}
                  >
                    <Focus size={16} />
                  </button>
                )}
              </div>
            )}
            <div className="map-selection">
              {(selectedId || selectedDependency) && (
                <>
                  <span title={selectedDependency?.summary ?? selectedId ?? undefined}>
                    {selectedDependency?.summary ?? selectedId}
                  </span>
                  <button className="text-button" onClick={() => revealRegion('record')}>
                    View details <ArrowDown size={13} />
                  </button>
                </>
              )}
            </div>
            {!isBoard && (
              <Popover.Root>
                <Popover.Trigger
                  className="map-help-trigger"
                  aria-label="Map navigation help"
                  title="Map navigation help"
                >
                  <Info size={16} />
                </Popover.Trigger>
                <Popover.Portal container={portal}>
                  <Popover.Positioner
                    className="picker-positioner"
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={16}
                  >
                    <Popover.Popup className="map-help-popup">
                      <Popover.Title>Navigate the map</Popover.Title>
                      <p>Drag to pan, pinch to zoom, or press F to fit the map.</p>
                      <p>
                        Arrows point from a prerequisite to its dependent. Select a line
                        to see which steps connect them.
                      </p>
                      <p>
                        Select a step to inspect its record. View details opens the right
                        panel.
                      </p>
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
          </footer>
        </main>

        <PlanPanelDivider
          workspaceRef={workspaceRef}
          value={panelLayout.width}
          isHidden={!panelLayout.isVisible}
          onChange={(width) => setPanelLayout((current) => ({ ...current, width }))}
          onCollapse={hidePanel}
        />
        <section
          className="plan-panel"
          id="plan-panel"
          hidden={!panelLayout.isVisible}
          aria-label="Plan list and record"
          ref={panelRef}
        >
          <Tabs.Root
            className="panel-tabs"
            value={navTab}
            onValueChange={(value: unknown) => {
              if (
                value === 'plan' ||
                value === 'details' ||
                value === 'changes' ||
                value === 'source'
              )
                changeSection(value)
            }}
          >
            <Tabs.List
              className="document-tabs panel-tab-list"
              aria-label="Plan sections"
              activateOnFocus
            >
              <Tabs.Tab value="plan" ref={stepsTabRef}>
                Steps <span>{searchResults.length}</span>
              </Tabs.Tab>
              <Tabs.Tab value="details">Details</Tabs.Tab>
              <Tabs.Tab value="changes">
                Changes <span>{report.changes.length}</span>
              </Tabs.Tab>
              <Tabs.Tab value="source">Source</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel
              value="plan"
              keepMounted
              className="panel-section list-section"
              ref={listRef}
            >
              <div className="panel-heading">
                <h2>
                  {hasSearch
                    ? 'Search results'
                    : activeGroup && !focus
                      ? activeGroup.title
                      : focus
                        ? 'Connected steps'
                        : 'Steps'}
                </h2>
                <button className="text-button" onClick={() => revealRegion('record')}>
                  {selectedId ? `${selectedId} details` : 'View record'}{' '}
                  <ArrowRight size={13} />
                </button>
                <button
                  className="text-button"
                  onClick={() => navigate({ kind: 'recap' })}
                >
                  Recap
                </button>
              </div>
              {hasSearch && (
                <p className="search-scope-note">
                  Across all workstreams. Show on map locates a step; Enter in search
                  locates the first result.
                </p>
              )}
              <PlanList
                items={searchResults}
                model={model}
                selectedId={selectedId}
                onSelect={selectItem}
                onInspect={(id) => inspectRecord({ kind: 'item', id })}
                onShowOnMap={hasSearch ? showSearchResult : undefined}
              />
              {(query || searchResults.length !== report.items.length) && (
                <p className="list-note">
                  {searchResults.length} of {report.items.length} steps
                  {hasSearch ? ' · across all workstreams' : ''}
                </p>
              )}
              {searchResults.length === 0 && (
                <p className="empty-note">
                  {hasSearch
                    ? 'No matching steps in this plan. Try a step name, ID, workstream or ticket.'
                    : 'No steps match the diagram filters.'}
                </p>
              )}
            </Tabs.Panel>
            <Tabs.Panel
              value="changes"
              keepMounted
              className="panel-section"
              ref={changesRef}
            >
              <div className="panel-heading">
                <h2>Change history</h2>
              </div>
              <PanelSearch
                label="Find a change"
                value={changeQuery}
                onChange={setChangeQuery}
              />
              <div className="change-navigation">
                <p className="small-label">
                  {
                    report.changes.filter(
                      (change) =>
                        change.status === 'accepted' || change.status === 'recorded',
                    ).length
                  }{' '}
                  recorded ·{' '}
                  {report.changes.filter((change) => change.status === 'proposed').length}{' '}
                  proposed ·{' '}
                  {report.changes.filter((change) => change.status === 'rejected').length}{' '}
                  rejected
                </p>
                {shownChanges.map(changeCard)}
                {shownChanges.length === 0 && (
                  <p className="empty-note">No matching change records.</p>
                )}
              </div>
            </Tabs.Panel>
            <Tabs.Panel value="source" keepMounted className="panel-section">
              <div className="panel-heading">
                <h2>Source</h2>
              </div>
              <div className="source-details">
                <p className="source-path">{sourcePath ?? 'Registered local ADR'}</p>
                <dl>
                  <div>
                    <dt>Decision</dt>
                    <dd>{report.decisionStatus}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{report.updatedAt}</dd>
                  </div>
                  <div>
                    <dt>Baseline</dt>
                    <dd>
                      {report.baselineKind} · {report.baselineDate}
                    </dd>
                  </div>
                </dl>
                <p>{report.sourceContext}</p>
                <p className="muted">
                  Read-only. Status and evidence come from the ADR; the viewer does not
                  independently verify them.
                </p>
                <h3>Context</h3>
                <p>{report.context}</p>
                <h3>Consequences</h3>
                <p>{report.consequences}</p>
              </div>
            </Tabs.Panel>
            <Tabs.Panel
              value="details"
              keepMounted
              className="panel-section inspector"
              ref={detailRef}
            >
              <div className="inspector-bar">
                <span>
                  {selection.kind === 'recap'
                    ? 'Plan recap'
                    : selection.kind === 'dependency'
                      ? 'Dependency'
                      : selection.kind === 'group'
                        ? 'Workstream'
                        : selection.kind === 'change'
                          ? 'Change record'
                          : 'Step details'}
                </span>
                <div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Copy ADR path and view"
                    onClick={() => void copyLink()}
                  >
                    <Copy />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Back to steps"
                    onClick={() => {
                      changeSection('plan')
                      stepsTabRef.current?.focus({ preventScroll: true })
                    }}
                  >
                    <ChevronLeft />
                  </Button>
                </div>
              </div>
              <div className="inspector-body">
                {notice && <output className="copy-notice">{notice}</output>}
                {selectedDependency ? (
                  <DependencyDetails
                    dependency={selectedDependency}
                    onInspect={(id) => inspectRecord({ kind: 'item', id })}
                  />
                ) : selection.kind === 'dependency' ? (
                  <>
                    <h2>Dependency no longer present</h2>
                    <p className="full-title">
                      This connection is no longer recorded in the current plan.
                    </p>
                  </>
                ) : selectedItem ? (
                  <>
                    <div className="detail-eyebrow">
                      <span>{selectedItem.id}</span>
                      <StatusMark status={selectedItem.status} label />
                    </div>
                    <h2>{selectedItem.shortTitle}</h2>
                    {selectedItem.title !== selectedItem.shortTitle && (
                      <p className="full-title">{selectedItem.title}</p>
                    )}
                    {activeGroup && selectedItem.groupId !== activeGroup.id && (
                      <p className="outside-workstream-note">
                        This step is in {groupById[selectedItem.groupId].title}, outside
                        the current workstream.{' '}
                        <button
                          className="text-button"
                          onClick={() => chooseWorkstream(selectedItem.groupId)}
                        >
                          Open its workstream <ArrowRight size={13} />
                        </button>
                      </p>
                    )}
                    <div className="detail-tags">
                      <span>
                        {selectedItem.origin === 'added'
                          ? 'Added after the plan'
                          : 'Original scope'}
                      </span>
                      {selectedItem.changed && (
                        <span className="delta-label">Changed since plan</span>
                      )}
                      {selectedItem.tickets.map((ticket) => (
                        <TicketReference
                          key={`${ticket.id}:${ticket.url ?? ''}`}
                          ticket={ticket}
                        />
                      ))}
                    </div>
                    <BlockerDetails
                      item={selectedItem}
                      model={model}
                      onInspect={(id) => inspectRecord({ kind: 'item', id })}
                    />
                    {(selectedItem.changed ||
                      selectedItem.origin === 'added' ||
                      selectedItem.status === 'dropped') && (
                      <PlanComparison
                        item={selectedItem}
                        onSelectItem={selectItem}
                        onOpenChange={(id) => navigate({ kind: 'change', id })}
                      />
                    )}
                    <button
                      className="workstream-link"
                      onClick={() => openGroup(selectedItem.groupId)}
                    >
                      <Network size={14} />
                      {groupById[selectedItem.groupId].title}
                      <ChevronRight size={14} />
                    </button>
                    <Button
                      className="explore-button"
                      variant="outline"
                      onClick={() => {
                        changeMapView({
                          ...mapView,
                          view: 'steps',
                          focus: selectedItem.id,
                          filter: 'all',
                        })
                      }}
                    >
                      <Focus />
                      Show connected steps
                      <ArrowRight />
                    </Button>
                    <section className="detail-section">
                      <h3>Evidence</h3>
                      {selectedItem.evidence.length ? (
                        selectedItem.evidence.map((value) => <p key={value}>{value}</p>)
                      ) : (
                        <p className="muted">No evidence recorded.</p>
                      )}
                    </section>
                    {selectedItem.acceptance.length > 0 && (
                      <section className="detail-section">
                        <h3>Completion criteria</h3>
                        {selectedItem.acceptance.map((value) => (
                          <p key={value}>{value}</p>
                        ))}
                      </section>
                    )}
                    {selectedItem.status !== 'blocked' && (
                      <section className="detail-section">
                        <h3>Where this stands</h3>
                        {selectedItem.notes.length ? (
                          selectedItem.notes.map((note) => <p key={note}>{note}</p>)
                        ) : (
                          <p className="muted">
                            Recorded as {statusLabels[selectedItem.status].toLowerCase()}{' '}
                            in the report. No additional status evidence was included for
                            this step.
                          </p>
                        )}
                        <small className="source-label">
                          ADR updated · {report.snapshotDate}
                        </small>
                      </section>
                    )}
                    {report.sourceNotes
                      .filter((note) => note.itemId === selectedItem.id)
                      .map((note) => (
                        <div className="source-caution" key={note.itemId}>
                          <Info size={16} />
                          <p>{note.text}</p>
                        </div>
                      ))}
                    <section className="detail-section">
                      <h3>
                        <ArrowDown size={14} />
                        Needs first <span>{selectedItem.needs.length}</span>
                      </h3>
                      {selectedItem.needs.length ? (
                        selectedItem.needs.map((id) => itemLink(itemById[id]))
                      ) : (
                        <p className="muted">No prerequisite recorded.</p>
                      )}
                    </section>
                    <section className="detail-section">
                      <h3>
                        <ArrowUpRight size={14} />
                        Enables <span>{dependants(selectedItem.id).length}</span>
                      </h3>
                      {dependants(selectedItem.id).length ? (
                        dependants(selectedItem.id).map((item) => itemLink(item))
                      ) : (
                        <p className="muted">No downstream step recorded.</p>
                      )}
                    </section>
                    <details
                      className="recap-disclosure"
                      key={`history:${selectedItem.id}`}
                    >
                      <summary>
                        <span>Change history</span>
                        <span>
                          {selectedItemChanges.length}
                          <ChevronDown size={14} />
                        </span>
                      </summary>
                      {selectedItemChanges.length ? (
                        selectedItemChanges.map(changeCard)
                      ) : (
                        <p className="muted">No change record names this step.</p>
                      )}
                    </details>
                    <button
                      className="recap-bottom"
                      onClick={() => navigate({ kind: 'recap' })}
                    >
                      <FileText size={16} />
                      <span>Return to the plan recap</span>
                      <ArrowRight size={15} />
                    </button>
                  </>
                ) : selectedGroup ? (
                  <>
                    <span className="detail-eyebrow">
                      {selectedGroup.ids.length} steps
                    </span>
                    <h2>{selectedGroup.title}</h2>
                    <p className="full-title">{selectedGroup.recap}</p>
                    <div className="group-status-summary">
                      {counts(selectedGroup.ids.map((id) => itemById[id])).done} done ·{' '}
                      {counts(selectedGroup.ids.map((id) => itemById[id])).active} in
                      progress
                    </div>
                    {selectedGroup.ids.some(
                      (id) => itemById[id].status === 'blocked',
                    ) && (
                      <section className="detail-section">
                        <h3>Blocked steps</h3>
                        {selectedGroup.ids
                          .map((id) => itemById[id])
                          .filter((item) => item.status === 'blocked')
                          .map((item) => (
                            <button
                              key={item.id}
                              className="related-step"
                              onClick={() => inspectRecord({ kind: 'item', id: item.id })}
                            >
                              <StatusMark status={item.status} />
                              <span>
                                <small>{item.id}</small>
                                {item.shortTitle}
                              </span>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                      </section>
                    )}
                    <Button
                      className="explore-button"
                      variant="outline"
                      onClick={() => chooseWorkstream(selectedGroup.id)}
                    >
                      <GitBranch />
                      Open workstream
                      <ArrowRight />
                    </Button>
                    {selectedConnections && (
                      <>
                        <section className="detail-section">
                          <h3>
                            Needs from other workstreams{' '}
                            <span>{selectedConnections.incoming.length}</span>
                          </h3>
                          {selectedConnections.incoming.length ? (
                            selectedConnections.incoming.map((item) =>
                              itemLink(item, true),
                            )
                          ) : (
                            <p className="muted">
                              No prerequisites outside this workstream.
                            </p>
                          )}
                        </section>
                        <section className="detail-section">
                          <h3>
                            Enables in other workstreams{' '}
                            <span>{selectedConnections.outgoing.length}</span>
                          </h3>
                          {selectedConnections.outgoing.length ? (
                            selectedConnections.outgoing.map((item) =>
                              itemLink(item, true),
                            )
                          ) : (
                            <p className="muted">
                              No dependants outside this workstream.
                            </p>
                          )}
                        </section>
                      </>
                    )}
                    <section className="detail-section">
                      <h3>Steps in this workstream</h3>
                      {selectedGroup.ids.map((id) => itemLink(itemById[id]))}
                    </section>
                    <details
                      className="recap-disclosure"
                      key={`history:${selectedGroup.id}`}
                    >
                      <summary>
                        <span>Recorded changes</span>
                        <span>
                          {selectedGroupChanges.length}
                          <ChevronDown size={14} />
                        </span>
                      </summary>
                      {selectedGroupChanges.length ? (
                        selectedGroupChanges.map(changeCard)
                      ) : (
                        <p className="muted">No changes name these steps.</p>
                      )}
                    </details>
                    <p className="source-label">
                      Workstreams organise this view. They do not add requirements to the
                      source plan.
                    </p>
                    <button
                      className="recap-bottom"
                      onClick={() => navigate({ kind: 'recap' })}
                    >
                      <FileText size={16} />
                      Plan recap
                      <ArrowRight size={15} />
                    </button>
                  </>
                ) : selectedChange ? (
                  <>
                    <div className="detail-eyebrow">
                      <span>
                        {selectedChange.id} · {selectedChange.date}
                      </span>
                      <span
                        className={
                          selectedChange.status === 'proposed'
                            ? 'proposal-tag'
                            : 'recorded-tag'
                        }
                      >
                        {selectedChange.status === 'proposed'
                          ? 'Proposed, not decided'
                          : selectedChange.status}
                      </span>
                    </div>
                    <h2>
                      {selectedChange.status === 'proposed'
                        ? 'A decision still to make'
                        : 'How the plan changed'}
                    </h2>
                    <p className="change-author">{selectedChange.author}</p>
                    <section className="detail-section">
                      <h3>What changed</h3>
                      <p>{selectedChange.what}</p>
                    </section>
                    <section className="detail-section">
                      <h3>Why</h3>
                      <p>{selectedChange.why}</p>
                    </section>
                    <section className="detail-section">
                      <h3>Steps named in this record</h3>
                      {selectedChange.itemIds.length ? (
                        selectedChange.itemIds
                          .filter((id) => itemById[id])
                          .map((id) => itemLink(itemById[id]))
                      ) : (
                        <p className="muted">
                          This record concerns the overall plan and does not name a step
                          ID.
                        </p>
                      )}
                    </section>
                    <button
                      className="recap-bottom"
                      onClick={() => navigate({ kind: 'recap' })}
                    >
                      <FileText size={16} />
                      Plan recap
                      <ArrowRight size={15} />
                    </button>
                  </>
                ) : (
                  <>
                    <h2>Plan recap</h2>
                    <p className="goal-text">{report.goal}</p>
                    <section className="detail-section">
                      <h3>Original plan and changes</h3>
                      <details className="recap-disclosure original-plan-list">
                        <summary>
                          <span>See the original plan</span>
                          <span>
                            {report.baselineSteps.length} steps
                            <ChevronDown size={14} />
                          </span>
                        </summary>
                        <p className="source-label">
                          {report.baselineKind === 'reconstructed'
                            ? 'Reconstructed from earlier notes. Missing wording remains unknown.'
                            : 'The first recorded plan, preserved for comparison.'}
                        </p>
                        <ol>
                          {report.baselineSteps.map((original) => (
                            <li key={original.id}>
                              <button
                                className="original-step-link"
                                onClick={() => selectItem(original.id)}
                              >
                                <span>
                                  {original.title ??
                                    `Original wording not recorded for ${itemById[original.id].shortTitle}`}
                                </span>
                                <ArrowRight size={14} />
                              </button>
                            </li>
                          ))}
                        </ol>
                      </details>
                      <p>
                        Choose a step to compare its original plan with what is recorded
                        now.
                      </p>
                      {[
                        {
                          label: 'Changed steps',
                          items: report.items.filter(
                            (item) => item.changed && item.status !== 'dropped',
                          ),
                        },
                        {
                          label: 'Added steps',
                          items: report.items.filter(
                            (item) =>
                              item.origin === 'added' && item.status !== 'dropped',
                          ),
                        },
                        {
                          label: 'Parked steps',
                          items: report.items.filter((item) => item.status === 'dropped'),
                        },
                      ]
                        .filter((group) => group.items.length > 0)
                        .map((group) => (
                          <details
                            className="recap-disclosure comparison-list"
                            key={group.label}
                          >
                            <summary>
                              <span>{group.label}</span>
                              <span>
                                {group.items.length}
                                <ChevronDown size={14} />
                              </span>
                            </summary>
                            {group.items.map((item) => itemLink(item))}
                          </details>
                        ))}
                      <button
                        className="text-button"
                        onClick={() => revealRegion('changes')}
                      >
                        Read all {report.changes.length} change records
                        <ArrowRight size={13} />
                      </button>
                    </section>
                    <section className="detail-section">
                      <h3>Where the work is now</h3>
                      <p>Steps currently recorded as in progress or blocked.</p>
                      {report.items
                        .filter((item) =>
                          ['in_progress', 'blocked'].includes(item.status),
                        )
                        .map((item) => (
                          <button
                            className="current-work"
                            key={item.id}
                            onClick={() => selectItem(item.id)}
                          >
                            <StatusMark status={item.status} />
                            <span>
                              <b>{item.shortTitle}</b>
                              <small>
                                {item.id} · {groupById[item.groupId].title}
                              </small>
                            </span>
                            <ChevronRight size={16} />
                          </button>
                        ))}
                      {!report.items.some((item) =>
                        ['in_progress', 'blocked'].includes(item.status),
                      ) && (
                        <p className="muted">
                          No work is currently marked in progress or blocked.
                        </p>
                      )}
                    </section>
                    <details className="recap-disclosure">
                      <summary>
                        <span>Needs a decision</span>
                        <span>
                          {
                            report.changes.filter(
                              (change) => change.status === 'proposed',
                            ).length
                          }{' '}
                          proposed
                          <ChevronDown size={14} />
                        </span>
                      </summary>
                      {report.changes
                        .filter((change) => change.status === 'proposed')
                        .map(changeCard)}
                    </details>
                    <details className="recap-disclosure">
                      <summary>
                        <span>Decision · {report.decisionStatus}</span>
                        <span>
                          {report.decisions.length}
                          <ChevronDown size={14} />
                        </span>
                      </summary>
                      <ul>
                        {report.decisions.map((decision) => (
                          <li key={decision}>{decision}</li>
                        ))}
                      </ul>
                    </details>
                    <details className="recap-disclosure">
                      <summary>
                        <span>Checks &amp; evidence</span>
                        <span>
                          {report.verification.length}
                          <ChevronDown size={14} />
                        </span>
                      </summary>
                      <p className="source-label">
                        Check outcomes and evidence as recorded in the ADR.
                      </p>
                      <ol>
                        {report.verification.map((check) => (
                          <li key={check}>{check}</li>
                        ))}
                      </ol>
                    </details>
                    <details className="recap-disclosure">
                      <summary>
                        <span>Open questions</span>
                        <span>
                          {report.questions.length}
                          <ChevronDown size={14} />
                        </span>
                      </summary>
                      <ul>
                        {report.questions.map((question) => (
                          <li key={question}>{question}</li>
                        ))}
                      </ul>
                    </details>
                    <details className="recap-disclosure">
                      <summary>
                        <span>About this snapshot</span>
                        <Info size={14} />
                      </summary>
                      <p>{report.sourceContext}</p>
                      <p>
                        Baseline: {report.baselineKind} · {report.baselineDate}. Status
                        and evidence are recorded by the session; this viewer does not
                        independently verify them.
                      </p>
                      <h3>Context</h3>
                      <p>{report.context}</p>
                      <h3>Consequences</h3>
                      <p>{report.consequences}</p>
                    </details>
                  </>
                )}
              </div>
              {selectedItem && (
                <div className="detail-pager">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={selectedIndex <= 0}
                    onClick={() => selectItem(visibleItems[selectedIndex - 1].id)}
                  >
                    <ChevronLeft />
                    Previous
                  </Button>
                  <span>
                    {selectedIndex < 0
                      ? 'Outside this view'
                      : `${selectedIndex + 1} of ${visibleItems.length}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      selectedIndex < 0 || selectedIndex >= visibleItems.length - 1
                    }
                    onClick={() => selectItem(visibleItems[selectedIndex + 1].id)}
                  >
                    Next
                    <ChevronRight />
                  </Button>
                </div>
              )}
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </div>
    </div>
  )
}

export function PlanExplorer({
  report,
  dark,
  sourcePath,
}: {
  report: Report
  dark: boolean
  sourcePath?: string
}) {
  const model = useMemo(() => createPlanModel(report), [report])
  return (
    <PlanContext value={model}>
      <ReactFlowProvider>
        <Explorer dark={dark} sourcePath={sourcePath} />
      </ReactFlowProvider>
    </PlanContext>
  )
}
