import { parseDocument } from 'yaml'
import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
const text = z.string().trim().min(1)
const texts = z.array(text).default([])
const ids = z.array(id).default([])
const date = z.iso.datetime({ offset: true })
const baselineStep = z.strictObject({
  id,
  title: text.nullable(),
  needs: z.array(id).nullable(),
})
const ticket = z.union([
  text,
  z.strictObject({ id: text, url: z.url({ protocol: /^https?$/ }) }),
])
const step = z.strictObject({
  id,
  title: text,
  short_title: text.optional(),
  group: id,
  status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'parked']),
  needs: ids,
  notes: texts,
  evidence: texts,
  acceptance: texts,
  tickets: z.array(ticket).default([]),
})
export const adrSchema = z.strictObject({
  schema: z.literal('plan-map/v1'),
  id,
  title: text,
  goal: text,
  decision_status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  updated_at: date,
  baseline: z.strictObject({
    kind: z.enum(['original', 'reconstructed']),
    captured_at: date,
    note: text,
    steps: z.array(baselineStep).min(1),
  }),
  groups: z.array(z.strictObject({ id, title: text, recap: text })).min(1),
  steps: z.array(step).min(1),
  changes: z
    .array(
      z.strictObject({
        id,
        at: date,
        author: text,
        status: z.enum(['proposed', 'accepted', 'rejected', 'recorded']),
        summary: text,
        why: text,
        affects: ids,
        evidence: texts,
      }),
    )
    .default([]),
  assumptions: z
    .array(
      z.strictObject({
        id,
        statement: text,
        status: z.enum(['untested', 'supported', 'disproved']),
        evidence: texts,
      }),
    )
    .default([]),
  checks: z
    .array(
      z.strictObject({
        id,
        title: text,
        status: z.enum(['not_run', 'passed', 'failed']),
        evidence: texts,
      }),
    )
    .default([]),
  questions: texts,
  sessions: z.array(z.strictObject({ id: text, attached_at: date })).default([]),
})
export type Adr = z.infer<typeof adrSchema>
export type AdrDocument = {
  plan: Adr
  context: string
  decision: string
  consequences: string
  markdown: string
}

export function parseAdr(markdown: string): AdrDocument {
  if (markdown.length > 1_000_000) throw new Error('ADR exceeds the 1 MB limit.')
  const blocks = [...markdown.matchAll(/^```yaml plan-map\s*\r?\n([\s\S]*?)^```\s*$/gm)]
  if (blocks.length !== 1)
    throw new Error('Include exactly one fenced “yaml plan-map” block.')
  const yaml = parseDocument(blocks[0][1], { uniqueKeys: true })
  if (yaml.errors.length)
    throw new Error(yaml.errors.map((error) => error.message).join('\n'))
  const result = adrSchema.safeParse(yaml.toJS({ maxAliasCount: 0 }))
  if (!result.success)
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('\n'),
    )
  const plan = result.data
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length)
      throw new Error(`${label} must have unique IDs.`)
  }
  unique(
    plan.steps.map((item) => item.id),
    'Steps',
  )
  unique(
    plan.groups.map((item) => item.id),
    'Groups',
  )
  unique(
    plan.baseline.steps.map((item) => item.id),
    'Baseline steps',
  )
  unique(
    plan.changes.map((item) => item.id),
    'Changes',
  )
  unique(
    plan.assumptions.map((item) => item.id),
    'Assumptions',
  )
  unique(
    plan.checks.map((item) => item.id),
    'Checks',
  )
  unique(
    plan.sessions.map((item) => item.id),
    'Sessions',
  )
  const steps = new Map(plan.steps.map((item) => [item.id, item]))
  const groups = new Set(plan.groups.map((item) => item.id))
  const baselineIds = new Set(plan.baseline.steps.map((item) => item.id))
  const references = (values: string[], available: Set<string>, label: string) => {
    unique(values, label)
    values.forEach((value) => {
      if (!available.has(value)) throw new Error(`${label}: unknown ID ${value}.`)
    })
  }
  plan.steps.forEach((item) => {
    if (!groups.has(item.group))
      throw new Error(`${item.id}: unknown group ${item.group}.`)
    references(item.needs, new Set(steps.keys()), `${item.id} prerequisites`)
    if (item.status === 'done' && !item.evidence.length)
      throw new Error(
        `${item.id}: done requires evidence; a source report can be cited as reported, not verified.`,
      )
  })
  plan.baseline.steps.forEach((item) => {
    if (!steps.has(item.id))
      throw new Error(`Retain baseline step ${item.id}; mark removed work parked.`)
    if (plan.baseline.kind === 'original' && (item.title === null || item.needs === null))
      throw new Error(
        `${item.id}: a new original baseline requires its title and prerequisites.`,
      )
    if (item.needs !== null)
      references(item.needs, baselineIds, `${item.id} baseline prerequisites`)
  })
  plan.changes.forEach((change) =>
    references(change.affects, new Set(steps.keys()), `${change.id} affected steps`),
  )
  ;[...plan.checks, ...plan.assumptions].forEach((item) => {
    if (!['not_run', 'untested'].includes(item.status) && !item.evidence.length)
      throw new Error(`${item.id}: ${item.status} requires evidence.`)
  })
  const assertAcyclic = (items: { id: string; needs: string[] }[], label: string) => {
    const lookup = new Map(items.map((item) => [item.id, item]))
    const active = new Set<string>()
    const complete = new Set<string>()
    const visit = (itemId: string) => {
      if (active.has(itemId))
        throw new Error(`${label}: dependency cycle involving ${itemId}.`)
      if (complete.has(itemId)) return
      active.add(itemId)
      lookup.get(itemId)!.needs.forEach(visit)
      active.delete(itemId)
      complete.add(itemId)
    }
    items.forEach((item) => visit(item.id))
  }
  assertAcyclic(plan.steps, 'Current plan')
  assertAcyclic(
    plan.baseline.steps.map((item) => ({ ...item, needs: item.needs ?? [] })),
    'Known baseline dependencies',
  )
  const prose = markdown.replace(blocks[0][0], '')
  const section = (name: string) => {
    const found = prose
      .match(
        new RegExp(`^## ${name}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'),
      )?.[1]
      .trim()
    if (!found) throw new Error(`Include a non-empty “## ${name}” section.`)
    return found
  }
  return {
    plan,
    context: section('Context'),
    decision: section('Decision'),
    consequences: section('Consequences'),
    markdown,
  }
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export function validateUpdate(before: Adr, after: Adr) {
  if (before.id !== after.id) throw new Error('Keep the ADR ID unchanged.')
  if (canonical(before.baseline) !== canonical(after.baseline))
    throw new Error('The original baseline is immutable. Record a change instead.')
  if (Date.parse(after.updated_at) <= Date.parse(before.updated_at))
    throw new Error('Advance updated_at for the new revision.')
  before.steps.forEach((item) => {
    if (!after.steps.some((candidate) => candidate.id === item.id))
      throw new Error(`Keep ${item.id}; mark removed work parked.`)
  })
  before.changes.forEach((change) => {
    if (!after.changes.some((candidate) => canonical(candidate) === canonical(change)))
      throw new Error(`Keep change ${change.id} unchanged; append a new decision record.`)
  })
  const newChanges = after.changes.filter(
    (change) => !before.changes.some((old) => old.id === change.id),
  )
  after.steps.forEach((item) => {
    const old = before.steps.find((candidate) => candidate.id === item.id)
    const scopeChanged =
      !old ||
      old.title !== item.title ||
      canonical([...old.needs].sort()) !== canonical([...item.needs].sort()) ||
      (old.status !== 'parked' && item.status === 'parked')
    if (
      scopeChanged &&
      !newChanges.some(
        (change) =>
          ['accepted', 'recorded'].includes(change.status) &&
          change.affects.includes(item.id),
      )
    )
      throw new Error(
        `${item.id}: scope changes require a new accepted or recorded change naming this step.`,
      )
  })
}
