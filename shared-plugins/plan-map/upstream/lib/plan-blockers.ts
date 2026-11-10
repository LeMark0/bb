import type { PlanItem, PlanModel } from './plan'

export function blockerInfo(item: PlanItem, model: Pick<PlanModel, 'itemById'>) {
  if (item.status !== 'blocked') return null
  const notes = item.notes.filter((note) => note.trim())
  const unfinished = item.needs
    .map((id) => model.itemById[id])
    .filter((step) => step.status !== 'done')
  const summary =
    notes[0] ??
    (unfinished.length
      ? `Needs ${unfinished
          .slice(0, 2)
          .map((step) => step.shortTitle)
          .join(
            ', ',
          )}${unfinished.length > 2 ? ` and ${unfinished.length - 2} more` : ''}.`
      : 'No status note recorded.')
  return { notes, unfinished, summary }
}
