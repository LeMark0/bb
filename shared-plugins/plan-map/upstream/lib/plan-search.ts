import type { PlanModel } from './plan'

function matchRank(id: string, titles: string[], term: string) {
  if (id === term) return 0
  if (titles.includes(term)) return 1
  if (id.includes(term)) return 2
  if (titles.some((title) => title.includes(term))) return 3
  return 4
}

export function searchPlan(model: PlanModel, query: string) {
  const term = query.toLowerCase().trim().replace(/\s+/g, ' ')
  if (!term) return model.report.items

  const words = term.split(' ')
  return model.report.items
    .map((item) => {
      const group = model.groupById[item.groupId]
      const text = [
        item.id,
        item.shortTitle,
        item.title,
        group.id,
        group.title,
        ...item.notes,
        ...item.tickets.map((ticket) => ticket.id),
      ]
        .join(' ')
        .toLowerCase()
      const id = item.id.toLowerCase()
      const titles = [item.shortTitle.toLowerCase(), item.title.toLowerCase()]
      const rank = matchRank(id, titles, term)
      return { item, text, rank }
    })
    .filter(({ text }) => words.every((word) => text.includes(word)))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item)
}
