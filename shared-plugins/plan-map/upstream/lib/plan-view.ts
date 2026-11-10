import type { PlanItem, PlanModel, Status } from './plan'

export type PlanView = {
  view: 'overview' | 'steps' | 'board'
  filter: 'all' | 'active' | 'original' | 'changed' | 'blocked'
  scope: string | null
  focus: string | null
}

export function readPlanView(url: URL, model: PlanModel): PlanView {
  const scope = url.searchParams.get('workstream')
  const focus = url.searchParams.get('focus')
  const filter = url.searchParams.get('filter')
  if (url.searchParams.get('view') === 'overview')
    return { view: 'overview', scope: null, focus: null, filter: 'all' }
  return {
    view: url.searchParams.get('view') === 'board' ? 'board' : 'steps',
    scope: scope && Object.hasOwn(model.groupById, scope) ? scope : null,
    focus: focus && Object.hasOwn(model.itemById, focus) ? focus : null,
    filter:
      filter === 'active' ||
      filter === 'original' ||
      filter === 'changed' ||
      filter === 'blocked'
        ? filter
        : 'all',
  }
}

export function planViewUrl(url: URL, state: PlanView) {
  const next = new URL(url)
  const values = {
    view: state.view === 'steps' ? null : state.view,
    workstream: state.scope,
    focus: state.focus,
    filter: state.filter === 'all' ? null : state.filter,
  }
  Object.entries(values).forEach(([key, value]) => {
    if (value) next.searchParams.set(key, value)
    else next.searchParams.delete(key)
  })
  return next
}

export function visiblePlanItems(model: PlanModel, state: PlanView) {
  const focused = state.focus ? model.neighbours(state.focus) : null
  return model.report.items.filter((item) => {
    if (state.view === 'overview') return true
    if (focused) return focused.has(item.id)
    if (state.scope && item.groupId !== state.scope) return false
    if (state.filter === 'active') return item.status === 'in_progress'
    if (state.filter === 'blocked') return item.status === 'blocked'
    if (state.filter === 'original') return item.origin === 'baseline'
    if (state.filter === 'changed')
      return item.origin === 'added' || item.changed || item.status === 'dropped'
    return true
  })
}

export function searchResultView(
  model: PlanModel,
  state: PlanView,
  id: string,
): PlanView {
  const stepsView: PlanView = { ...state, view: 'steps' }
  if (
    state.view !== 'overview' &&
    visiblePlanItems(model, stepsView).some((item) => item.id === id)
  )
    return stepsView
  return { view: 'steps', scope: model.itemById[id].groupId, filter: 'all', focus: null }
}

export function planBoardColumns(items: PlanItem[]) {
  const statuses: Status[] = ['todo', 'in_progress', 'blocked', 'done', 'dropped']
  return statuses.map((status) => ({
    status,
    items: items.filter((item) => item.status === status),
  }))
}

export function workstreamConnections(model: PlanModel, groupId: string) {
  const ids = new Set(model.groupById[groupId]?.ids ?? [])
  const prerequisites = new Set(
    model.report.items.filter((item) => ids.has(item.id)).flatMap((item) => item.needs),
  )
  const outside = model.report.items.filter((item) => !ids.has(item.id))
  return {
    incoming: outside.filter((item) => prerequisites.has(item.id)),
    outgoing: outside.filter((item) => item.needs.some((id) => ids.has(id))),
  }
}

export function workstreamLinks(model: PlanModel) {
  const links = new Map<
    string,
    {
      id: string
      source: string
      target: string
      steps: { source: string; target: string }[]
    }
  >()
  model.report.items.forEach((item) => {
    item.needs.forEach((id) => {
      const source = model.itemById[id].groupId
      const target = item.groupId
      if (source === target) return
      const key = `${source}:${target}`
      const link = links.get(key) ?? { id: key, source, target, steps: [] }
      link.steps.push({ source: id, target: item.id })
      links.set(key, link)
    })
  })
  return [...links.values()]
}

export function dependencyDetails(model: PlanModel, id: string) {
  if (!id) return null
  const [kind, source, target, extra] = id.split(':')
  if (extra !== undefined || !source || !target) return null
  const records = kind === 'workstream' ? model.groupById : model.itemById
  if (!Object.hasOwn(records, source) || !Object.hasOwn(records, target)) return null
  const steps =
    kind === 'workstream'
      ? workstreamLinks(model).find(
          (link) => link.source === source && link.target === target,
        )?.steps
      : kind === 'step' && model.itemById[target].needs.includes(source)
        ? [{ source, target }]
        : null
  if (!steps?.length) return null
  const sourceTitle =
    kind === 'workstream'
      ? model.groupById[source].title
      : model.itemById[source].shortTitle
  const targetTitle =
    kind === 'workstream'
      ? model.groupById[target].title
      : model.itemById[target].shortTitle
  const prerequisiteCount = new Set(steps.map((step) => step.source)).size
  return {
    id,
    kind,
    sourceTitle,
    targetTitle,
    prerequisiteCount,
    summary:
      kind === 'workstream'
        ? `${targetTitle} needs ${prerequisiteCount} ${prerequisiteCount === 1 ? 'step' : 'steps'} from ${sourceTitle}`
        : `${targetTitle} needs ${sourceTitle}`,
    dependents: [...new Set(steps.map((step) => step.target))].map((targetId) => ({
      item: model.itemById[targetId],
      needs: steps
        .filter((step) => step.target === targetId)
        .map((step) => model.itemById[step.source]),
    })),
  }
}

export type PlanDependency = NonNullable<ReturnType<typeof dependencyDetails>>
