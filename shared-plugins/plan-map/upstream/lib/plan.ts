import type { AdrDocument } from './adr'

export type Status = 'done' | 'in_progress' | 'todo' | 'dropped' | 'blocked'
export type PlanTicket = { id: string; url?: string }
export type PlanItem = {
  id: string
  title: string
  shortTitle: string
  status: Status
  origin: 'baseline' | 'added'
  changed: boolean
  changeIds: string[]
  needs: string[]
  notes: string[]
  evidence: string[]
  acceptance: string[]
  groupId: string
  tickets: PlanTicket[]
  original?: { title: string | null; needs: string[] | null }
}
export type PlanGroup = { id: string; title: string; recap: string; ids: string[] }
export type PlanChange = {
  id: string
  date: string
  author: string
  status: 'proposed' | 'accepted' | 'recorded' | 'rejected'
  what: string
  why: string
  itemIds: string[]
  text: string
  evidence: string[]
}
export type Report = {
  id: string
  title: string
  goal: string
  snapshotDate: string
  updatedAt: string
  decisionStatus: string
  baselineDate: string
  baselineKind: string
  baselineSteps: AdrDocument['plan']['baseline']['steps']
  sourceContext: string
  context: string
  consequences: string
  items: PlanItem[]
  groups: PlanGroup[]
  changes: PlanChange[]
  decisions: string[]
  verification: string[]
  questions: string[]
  sourceNotes: { itemId: string; text: string }[]
  assumptions: AdrDocument['plan']['assumptions']
}
export const statusLabels: Record<Status, string> = {
  done: 'Done',
  in_progress: 'In progress',
  todo: 'To do',
  dropped: 'Parked',
  blocked: 'Blocked',
}
export const counts = (items: PlanItem[]) => ({
  done: items.filter((item) => item.status === 'done').length,
  active: items.filter((item) => item.status === 'in_progress').length,
  todo: items.filter((item) => item.status === 'todo').length,
  parked: items.filter((item) => item.status === 'dropped').length,
  blocked: items.filter((item) => item.status === 'blocked').length,
})
export function toReport({ plan, context, decision, consequences }: AdrDocument): Report {
  const dateLabel = (value: string) =>
    new Date(value).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  return {
    id: plan.id,
    title: plan.title,
    goal: plan.goal,
    updatedAt: plan.updated_at,
    decisionStatus: plan.decision_status,
    baselineKind: plan.baseline.kind,
    baselineSteps: plan.baseline.steps,
    snapshotDate: dateLabel(plan.updated_at),
    baselineDate: dateLabel(plan.baseline.captured_at),
    sourceContext: plan.baseline.note,
    context,
    consequences,
    items: plan.steps.map((item) => {
      const original = plan.baseline.steps.find((old) => old.id === item.id)
      return {
        id: item.id,
        title: item.title,
        shortTitle: item.short_title ?? item.title,
        status: item.status === 'parked' ? 'dropped' : item.status,
        origin: original ? 'baseline' : 'added',
        changed: Boolean(
          original &&
          ((original.title !== null && original.title !== item.title) ||
            (original.needs !== null &&
              JSON.stringify([...original.needs].sort()) !==
                JSON.stringify([...item.needs].sort())) ||
            (item.status !== 'parked' &&
              plan.changes.some(
                (change) =>
                  ['accepted', 'recorded'].includes(change.status) &&
                  change.affects.includes(item.id),
              ))),
        ),
        changeIds: plan.changes
          .filter((change) => change.affects.includes(item.id))
          .map((change) => change.id),
        needs: item.needs,
        notes: item.notes,
        evidence: item.evidence,
        acceptance: item.acceptance,
        groupId: item.group,
        tickets: item.tickets.map((ticket) => {
          if (typeof ticket !== 'string') return ticket
          try {
            const url = new URL(ticket)
            if (['http:', 'https:'].includes(url.protocol))
              return { id: ticket, url: ticket }
          } catch {
            // Plain ticket IDs remain readable without a known destination.
          }
          return { id: ticket }
        }),
        original,
      }
    }),
    groups: plan.groups
      .map((group) => ({
        ...group,
        ids: plan.steps.filter((item) => item.group === group.id).map((item) => item.id),
      }))
      .filter((group) => group.ids.length > 0),
    changes: plan.changes.map((change) => ({
      id: change.id,
      date: change.at,
      author: change.author,
      status: change.status,
      what: change.summary,
      why: change.why,
      itemIds: change.affects,
      text: [change.id, change.summary, change.why].join(' '),
      evidence: change.evidence,
    })),
    decisions: [decision],
    verification: plan.checks.map(
      (check) =>
        `${check.title} · ${check.status.replaceAll('_', ' ')}${check.evidence.length ? '\nEvidence: ' + check.evidence.join('; ') : ''}`,
    ),
    questions: plan.questions,
    sourceNotes: [],
    assumptions: plan.assumptions,
  }
}
export function createPlanModel(report: Report) {
  const itemById = Object.fromEntries(report.items.map((item) => [item.id, item]))
  const groupById = Object.fromEntries(report.groups.map((group) => [group.id, group]))
  const dependants = (id: string) =>
    report.items.filter((item) => item.needs.includes(id))
  const changesFor = (id: string) =>
    report.changes.filter((change) => change.itemIds.includes(id))
  const neighbours = (id: string) =>
    new Set([
      id,
      ...(itemById[id]?.needs ?? []),
      ...dependants(id).map((item) => item.id),
    ])
  return { report, itemById, groupById, dependants, changesFor, neighbours }
}
export type PlanModel = ReturnType<typeof createPlanModel>
