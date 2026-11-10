import { describe, expect, it } from 'vitest'

import type { PlanItem } from '../plan'
import { blockerInfo } from '../plan-blockers'

const step = (id: string, status: PlanItem['status']): PlanItem => ({
  id,
  status,
  title: id,
  shortTitle: id,
  groupId: 'example',
  origin: 'baseline',
  changed: false,
  changeIds: [],
  needs: [],
  notes: [],
  evidence: [],
  acceptance: [],
  tickets: [],
})
const prerequisites = [
  step('complete', 'done'),
  step('active', 'in_progress'),
  step('waiting', 'todo'),
  step('blocked', 'blocked'),
  step('removed', 'dropped'),
]
const model = {
  itemById: Object.fromEntries(prerequisites.map((item) => [item.id, item])),
}

describe('blocked step explanations', () => {
  it('should retain an external blocker note even when all recorded prerequisites are done', () => {
    const item = {
      ...step('release', 'blocked'),
      needs: ['complete'],
      notes: [
        'Waiting for the partner to approve access.',
        'A workaround is proposed, not approved.',
      ],
    }
    const info = blockerInfo(item, model)
    expect(info?.summary).toBe('Waiting for the partner to approve access.')
    expect(info?.notes).toEqual(item.notes)
    expect(info?.unfinished).toEqual([])
  })

  it('should exclude completed prerequisites but retain unfinished and parked dependencies', () => {
    const item = {
      ...step('release', 'blocked'),
      needs: prerequisites.map((dependency) => dependency.id),
    }
    const info = blockerInfo(item, model)
    expect(info?.unfinished.map((dependency) => dependency.id)).toEqual([
      'active',
      'waiting',
      'blocked',
      'removed',
    ])
    expect(info?.summary).toBe('Needs active, waiting and 2 more.')
    expect(model.itemById.removed.status).toBe('dropped')
  })

  it('should make missing notes explicit without inventing a reason', () => {
    expect(blockerInfo(step('unknown', 'blocked'), model)).toEqual({
      notes: [],
      unfinished: [],
      summary: 'No status note recorded.',
    })
    expect(
      blockerInfo({ ...step('unknown', 'blocked'), needs: ['complete'] }, model)?.summary,
    ).toBe('No status note recorded.')
  })

  it('should not mark an unblocked step as blocked because its prerequisites are unfinished', () => {
    expect(
      blockerInfo({ ...step('release', 'todo'), needs: ['active'] }, model),
    ).toBeNull()
  })
})
