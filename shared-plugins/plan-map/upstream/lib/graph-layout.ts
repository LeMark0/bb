import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre'

export type Point = { x: number; y: number }
export type GraphPort = Point & {
  id: string
  type: 'source' | 'target'
  side: 'top' | 'right' | 'bottom' | 'left'
}
type LayoutNode = { id: string; width: number; height: number }
type LayoutLink = { id: string; source: string; target: string }
type PositionedNode = LayoutNode & { position: Point; ports: GraphPort[] }

function simplifyRoute(points: Point[]) {
  const route: Point[] = []
  for (const point of points) {
    if (route.at(-1)?.x === point.x && route.at(-1)?.y === point.y) continue
    while (route.length > 1) {
      const previous = route[route.length - 2]
      const last = route[route.length - 1]
      if (
        !(
          (previous.x === last.x && last.x === point.x) ||
          (previous.y === last.y && last.y === point.y)
        )
      )
        break
      route.pop()
    }
    route.push(point)
  }
  return route
}

export function roundedRoute(points: Point[]) {
  if (points.length < 2) return ''
  const commands = [`M ${points[0].x} ${points[0].y}`]
  points.slice(1, -1).forEach((point, index) => {
    const previous = points[index]
    const next = points[index + 2]
    const beforeLength = Math.hypot(previous.x - point.x, previous.y - point.y)
    const afterLength = Math.hypot(next.x - point.x, next.y - point.y)
    const radius = Math.min(8, beforeLength / 3, afterLength / 3)
    if (!radius) return
    const before = {
      x: point.x + ((previous.x - point.x) * radius) / beforeLength,
      y: point.y + ((previous.y - point.y) * radius) / beforeLength,
    }
    const after = {
      x: point.x + ((next.x - point.x) * radius) / afterLength,
      y: point.y + ((next.y - point.y) * radius) / afterLength,
    }
    commands.push(
      `L ${before.x} ${before.y} Q ${point.x} ${point.y} ${after.x} ${after.y}`,
    )
  })
  const last = points[points.length - 1]
  commands.push(`L ${last.x} ${last.y}`)
  return commands.join(' ')
}

function portTowards(
  adjacent: Point,
  node: PositionedNode,
  id: string,
  type: GraphPort['type'],
  horizontal: boolean,
): GraphPort {
  if (horizontal) {
    const right = adjacent.x > node.position.x + node.width / 2
    return {
      id,
      type,
      side: right ? 'right' : 'left',
      x: right ? node.width : 0,
      y: adjacent.y - node.position.y,
    }
  }
  const below = adjacent.y > node.position.y + node.height / 2
  return {
    id,
    type,
    side: below ? 'bottom' : 'top',
    x: adjacent.x - node.position.x,
    y: below ? node.height : 0,
  }
}

export function layoutGraph(
  nodes: LayoutNode[],
  links: LayoutLink[],
  options: GraphLabel,
) {
  const graph = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({
    multigraph: true,
  })
    .setGraph({ marginx: 32, marginy: 32, edgesep: 28, ...options })
    .setDefaultEdgeLabel(() => ({}))
  nodes.forEach((node) =>
    graph.setNode(node.id, { width: node.width, height: node.height }),
  )
  links.forEach((link) => graph.setEdge(link.source, link.target, {}, link.id))
  dagre.layout(graph)
  const positioned = Object.fromEntries(
    nodes.map((node): [string, PositionedNode] => {
      const point = graph.node(node.id)
      if (point.x === undefined || point.y === undefined)
        throw new Error(`Missing layout for ${node.id}`)
      return [
        node.id,
        {
          ...node,
          position: { x: point.x - node.width / 2, y: point.y - node.height / 2 },
          ports: [],
        },
      ]
    }),
  )
  const horizontal = ['LR', 'RL'].includes(options.rankdir ?? 'TB')
  const routes = links.map((link) => {
    const points = graph.edge({ v: link.source, w: link.target, name: link.id }).points
    if (!points?.length) throw new Error(`Missing route for ${link.id}`)
    const sourceHandle = `${link.id}:source`
    const targetHandle = `${link.id}:target`
    const sourcePort = portTowards(
      points[1],
      positioned[link.source],
      sourceHandle,
      'source',
      horizontal,
    )
    const targetPort = portTowards(
      points[points.length - 2],
      positioned[link.target],
      targetHandle,
      'target',
      horizontal,
    )
    positioned[link.source].ports.push(sourcePort)
    positioned[link.target].ports.push(targetPort)
    return { ...link, points, sourceHandle, targetHandle, sourcePort, targetPort }
  })
  // Keep attachment points separate, ordered by their lane in the gap between ranks.
  Object.values(positioned).forEach((node) => {
    const cross = horizontal ? 'y' : 'x'
    const length = horizontal ? node.height : node.width
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const ports = node.ports
        .filter((port) => port.side === side)
        .sort((a, b) => a[cross] - b[cross] || a.id.localeCompare(b.id))
      ports.forEach((port, index) => {
        port[cross] = (length * (index + 1)) / (ports.length + 1)
      })
    }
  })
  const axis = horizontal ? 'x' : 'y'
  const terminalLanes = new Map<number, string[]>()
  routes.forEach((link) => {
    for (const point of [link.points[1], link.points[link.points.length - 2]]) {
      const lanes = terminalLanes.get(point[axis]) ?? []
      if (!lanes.includes(link.id)) lanes.push(link.id)
      terminalLanes.set(point[axis], lanes)
    }
  })
  const laneFor = (position: number, id: string) => {
    const lanes = terminalLanes.get(position)!
    const clearance = Math.min(
      ...Object.values(positioned).map((node) => {
        const start = node.position[axis]
        const end = start + (horizontal ? node.width : node.height)
        return position < start ? start - position : Math.max(0, position - end)
      }),
    )
    const spread = Math.max(0, clearance - 12)
    return position + ((lanes.indexOf(id) + 1) / (lanes.length + 1) - 0.5) * spread * 2
  }
  const routed = routes.map(({ sourcePort, targetPort, ...link }) => {
    const source = positioned[link.source]
    const target = positioned[link.target]
    const start = {
      x: source.position.x + sourcePort.x,
      y: source.position.y + sourcePort.y,
    }
    const end = {
      x: target.position.x + targetPort.x,
      y: target.position.y + targetPort.y,
    }
    const interior = link.points.slice(1, -1).map((point) => ({ ...point }))
    // Separate horizontal/vertical runs in the same gap, including reciprocal links.
    // Keep the lanes inside its measured clearance, away from both neighbouring ranks.
    interior[0][axis] = laneFor(interior[0][axis], link.id)
    if (interior.length > 1)
      interior[interior.length - 1][axis] = laneFor(
        interior[interior.length - 1][axis],
        link.id,
      )
    // Dagre's terminal diagonals can cut across neighbouring cards in a wide rank.
    // Travel out to the inter-rank gap before crossing towards the next lane.
    const leave = horizontal
      ? { x: interior[0].x, y: start.y }
      : { x: start.x, y: interior[0].y }
    const enter = horizontal
      ? { x: interior.at(-1)!.x, y: end.y }
      : { x: end.x, y: interior.at(-1)!.y }
    const points = simplifyRoute([start, leave, ...interior, enter, end])
    return { ...link, points, path: roundedRoute(points) }
  })
  return { nodes: positioned, links: routed }
}
