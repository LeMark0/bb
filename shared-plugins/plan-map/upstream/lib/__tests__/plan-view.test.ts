import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseAdr } from '../adr'
import { createPlanModel, toReport, type PlanItem } from '../plan'
import { searchPlan } from '../plan-search'
import {
  dependencyDetails,
  planBoardColumns,
  planViewUrl,
  readPlanView,
  searchResultView,
  visiblePlanItems,
  workstreamConnections,
  workstreamLinks,
  type PlanView,
} from '../plan-view'

const template = toReport(
  parseAdr(
    readFileSync(
      new URL('../../skills/plan-map/assets/feature-adr.md', import.meta.url),
      'utf8',
    ),
  ),
)
const step = (
  id: string,
  groupId: string,
  status: PlanItem['status'],
  needs: string[] = [],
): PlanItem => ({
  id,
  groupId,
  status,
  needs,
  title: id,
  shortTitle: id,
  origin: 'baseline',
  changed: false,
  changeIds: [],
  notes: [],
  evidence: [],
  acceptance: [],
  tickets: [],
})
const model = createPlanModel({
  ...template,
  items: [
    step('contract', 'design', 'done'),
    step('api', 'build', 'in_progress', ['contract']),
    step('ui', 'build', 'blocked', ['contract', 'api']),
    step('launch', 'release', 'todo', ['api', 'ui']),
    step('other', 'release', 'in_progress'),
  ],
  groups: [
    { id: 'design', title: 'Design', recap: '', ids: ['contract'] },
    { id: 'build', title: 'Build', recap: '', ids: ['api', 'ui'] },
    { id: 'release', title: 'Release', recap: '', ids: ['launch', 'other'] },
  ],
})
const buildView: PlanView = { view: 'steps', scope: 'build', filter: 'all', focus: null }

describe('status board', () => {
  it('should place every step in exactly one status column and retain order within it', () => {
    const items = [...model.report.items, step('later', 'release', 'dropped')]
    const columns = planBoardColumns(items)
    expect(columns.map((column) => column.status)).toEqual([
      'todo',
      'in_progress',
      'blocked',
      'done',
      'dropped',
    ])
    const ids = columns.flatMap((column) => column.items.map((item) => item.id))
    expect(ids).toHaveLength(items.length)
    expect(new Set(ids)).toEqual(new Set(items.map((item) => item.id)))
    expect(
      columns
        .find((column) => column.status === 'in_progress')
        ?.items.map((item) => item.id),
    ).toEqual(['api', 'other'])
    expect(columns.find((column) => column.status === 'dropped')?.items[0].id).toBe(
      'later',
    )
    expect(items[0].id).toBe('contract')
  })

  it('should preserve workstream and filter scope while keeping empty columns visible', () => {
    const state: PlanView = { ...buildView, view: 'board', filter: 'blocked' }
    const columns = planBoardColumns(visiblePlanItems(model, state))
    expect(columns).toHaveLength(5)
    expect(columns.flatMap((column) => column.items.map((item) => item.id))).toEqual([
      'ui',
    ])
    expect(columns.filter((column) => column.items.length === 0)).toHaveLength(4)
    expect(planBoardColumns([]).every((column) => column.items.length === 0)).toBe(true)
  })

  it('should restore board links with workstream, filter, selection and map identity', () => {
    const source = new URL('http://127.0.0.1:5180/?map=example#item/ui')
    const state: PlanView = { ...buildView, view: 'board', filter: 'blocked' }
    const link = planViewUrl(source, state)
    expect(link.searchParams.get('view')).toBe('board')
    expect(readPlanView(link, model)).toEqual(state)
    expect(link.searchParams.get('map')).toBe('example')
    expect(link.hash).toBe('#item/ui')
    expect(planViewUrl(link, buildView).searchParams.has('view')).toBe(false)
    expect(
      readPlanView(
        new URL('http://localhost/?view=board&workstream=missing&filter=unknown'),
        model,
      ),
    ).toEqual({ view: 'board', scope: null, focus: null, filter: 'all' })
  })
})

describe('search result navigation', () => {
  it('should keep all workstreams when locating a result from the board', () => {
    const state: PlanView = { ...buildView, view: 'board', scope: null }
    expect(searchResultView(model, state, 'launch')).toEqual({ ...state, view: 'steps' })
  })
  it('should use the current board scope and retain filters containing the result', () => {
    const state: PlanView = {
      ...buildView,
      view: 'board',
      scope: 'release',
      filter: 'active',
    }
    expect(searchResultView(model, state, 'other')).toEqual({ ...state, view: 'steps' })
    expect(searchResultView(model, state, 'api')).toEqual(buildView)
    expect(searchResultView(model, state, 'launch')).toEqual({
      ...state,
      view: 'steps',
      filter: 'all',
    })
  })
})

describe('plan search', () => {
  const searchModel = createPlanModel({
    ...model.report,
    items: model.report.items.map((item) =>
      item.id === 'api'
        ? {
            ...item,
            shortTitle: 'Cache index',
            title: 'Store the published terms',
            notes: ['Keep the previous snapshot on an invalid revision'],
            tickets: [{ id: 'ENG-123' }],
          }
        : item,
    ),
  })

  it('should search IDs, both titles, notes and tickets without case sensitivity', () => {
    for (const query of [
      ' API ',
      'cache INDEX',
      'published terms',
      'invalid revision',
      'eng-123',
    ]) {
      expect(searchPlan(searchModel, query).map((item) => item.id)).toEqual(['api'])
    }
  })
  it('should find steps across workstreams and match words in different fields', () => {
    expect(searchPlan(searchModel, 'design').map((item) => item.id)).toEqual(['contract'])
    expect(searchPlan(searchModel, 'BUILD   cache').map((item) => item.id)).toEqual([
      'api',
    ])
    expect(searchPlan(searchModel, 'release').map((item) => item.id)).toEqual([
      'launch',
      'other',
    ])
    expect(
      visiblePlanItems(searchModel, { ...buildView, filter: 'blocked' }).map(
        (item) => item.id,
      ),
    ).not.toContain('api')
    expect(searchPlan(searchModel, 'eng-123').map((item) => item.id)).toEqual(['api'])
  })
  it('should require every search word and keep unmatched input safe', () => {
    expect(searchPlan(searchModel, 'cache nonexistent')).toEqual([])
    expect(searchPlan(searchModel, '[.*')).toEqual([])
  })
  it('should put an exact ID before partial matches without reordering the model', () => {
    const ranked = createPlanModel({
      ...model.report,
      items: [step('api-copy', 'build', 'todo'), ...model.report.items],
    })
    expect(searchPlan(ranked, 'api').map((item) => item.id)).toEqual(['api', 'api-copy'])
    expect(ranked.report.items[0].id).toBe('api-copy')
  })
  it('should rank an exact full title ahead of a notes-only match', () => {
    const ranked = createPlanModel({
      ...searchModel.report,
      items: searchModel.report.items.map((item) =>
        item.id === 'contract' ? { ...item, notes: ['Store the published terms'] } : item,
      ),
    })
    expect(
      searchPlan(ranked, 'Store the published terms').map((item) => item.id),
    ).toEqual(['api', 'contract'])
  })
  it('should restore the original list when the search is cleared', () => {
    expect(searchPlan(searchModel, ' \t ')).toEqual(searchModel.report.items)
  })
})

describe('workstream views', () => {
  it('should explain the exact steps behind a line without counting one prerequisite twice', () => {
    const dependency = dependencyDetails(model, 'workstream:design:build')!
    expect(dependency.summary).toBe('Build needs 1 step from Design')
    expect(dependency.prerequisiteCount).toBe(1)
    expect(
      dependency.dependents.map(({ item, needs }) => ({
        item: item.id,
        needs: needs.map((step) => step.id),
      })),
    ).toEqual([
      { item: 'api', needs: ['contract'] },
      { item: 'ui', needs: ['contract'] },
    ])
    expect(dependency.dependents[0].needs[0].status).toBe('done')
    expect(dependencyDetails(model, 'workstream:build:release')?.prerequisiteCount).toBe(
      2,
    )
  })

  it('should explain a step link in its recorded direction, including within one workstream', () => {
    const dependency = dependencyDetails(model, 'step:api:ui')!
    expect(dependency.summary).toBe('ui needs api')
    expect(dependency.dependents[0].item.status).toBe('blocked')
    expect(dependency.dependents[0].needs[0].status).toBe('in_progress')
    expect(dependencyDetails(model, 'step:ui:api')).toBeNull()
  })

  it('should reject missing, unrelated or stale dependency links', () => {
    for (const id of [
      '',
      'workstream:build:design',
      'workstream:build:build',
      'step:missing:ui',
      'step:contract:other',
      'step:contract:api:extra',
      'step:toString:api',
      'unknown:api:ui',
    ]) {
      expect(dependencyDetails(model, id)).toBeNull()
    }
  })
  it('should preserve both workstream directions without turning internal prerequisites into self-links', () => {
    const cyclicGroups = createPlanModel({
      ...model.report,
      items: [...model.report.items, step('amend-contract', 'design', 'todo', ['api'])],
      groups: model.report.groups.map((group) =>
        group.id === 'design'
          ? { ...group, ids: [...group.ids, 'amend-contract'] }
          : group,
      ),
    })
    const links = workstreamLinks(cyclicGroups)
    expect(links.map(({ source, target }) => `${source}:${target}`)).toEqual([
      'design:build',
      'build:release',
      'build:design',
    ])
    expect(links.find((link) => link.id === 'design:build')?.steps).toEqual([
      { source: 'contract', target: 'api' },
      { source: 'contract', target: 'ui' },
    ])
    expect(links.find((link) => link.id === 'build:design')?.steps).toEqual([
      { source: 'api', target: 'amend-contract' },
    ])
    expect(links.some((link) => link.source === link.target)).toBe(false)
  })
  it('should keep status filters inside the selected workstream', () => {
    expect(visiblePlanItems(model, buildView).map((item) => item.id)).toEqual([
      'api',
      'ui',
    ])
    expect(
      visiblePlanItems(model, { ...buildView, filter: 'active' }).map((item) => item.id),
    ).toEqual(['api'])
    expect(
      visiblePlanItems(model, { ...buildView, filter: 'blocked' }).map((item) => item.id),
    ).toEqual(['ui'])
  })

  it('should expose unique cross-workstream prerequisites and dependants without adding them to the slice', () => {
    const boundary = workstreamConnections(model, 'build')
    expect(boundary.incoming.map((item) => item.id)).toEqual(['contract'])
    expect(boundary.outgoing.map((item) => item.id)).toEqual(['launch'])
    expect(visiblePlanItems(model, buildView).map((item) => item.id)).not.toContain(
      'contract',
    )
    expect(model.itemById.ui.needs).toEqual(['contract', 'api'])
  })

  it('should show direct neighbours across workstreams only when explicitly focused', () => {
    expect(
      visiblePlanItems(model, { ...buildView, filter: 'blocked', focus: 'api' }).map(
        (item) => item.id,
      ),
    ).toEqual(['contract', 'api', 'ui', 'launch'])
    expect(visiblePlanItems(model, buildView).map((item) => item.id)).toEqual([
      'api',
      'ui',
    ])
  })

  it('should round-trip scope and filters in links without losing map identity or selection', () => {
    const source = new URL('http://127.0.0.1:5180/?map=example#item/api')
    const state: PlanView = { ...buildView, filter: 'active' }
    const link = planViewUrl(source, state)
    expect(readPlanView(link, model)).toEqual(state)
    expect(link.searchParams.get('map')).toBe('example')
    expect(link.hash).toBe('#item/api')
    expect(source.searchParams.has('workstream')).toBe(false)
    const full = planViewUrl(link, {
      view: 'steps',
      scope: null,
      focus: null,
      filter: 'all',
    })
    expect(full.href).toBe(source.href)
  })

  it('should restore a connected view and discard stale identifiers or invalid filters', () => {
    const state = { ...buildView, focus: 'api' }
    expect(readPlanView(planViewUrl(new URL('http://localhost/'), state), model)).toEqual(
      state,
    )
    expect(
      readPlanView(
        new URL('http://localhost/?workstream=removed&focus=missing&filter=bogus'),
        model,
      ),
    ).toEqual({ view: 'steps', scope: null, focus: null, filter: 'all' })
    expect(
      readPlanView(
        new URL('http://localhost/?workstream=__proto__&focus=toString'),
        model,
      ).scope,
    ).toBeNull()
  })

  it('should restore the overview independently of stale step filters', () => {
    const state = readPlanView(
      new URL(
        'http://localhost/?view=overview&workstream=build&focus=api&filter=blocked',
      ),
      model,
    )
    expect(state).toEqual({ view: 'overview', scope: null, focus: null, filter: 'all' })
    expect(visiblePlanItems(model, state)).toHaveLength(5)
  })
})
