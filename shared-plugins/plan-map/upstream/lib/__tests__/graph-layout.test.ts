import { describe, expect, it } from 'vitest'

import { layoutGraph } from '../graph-layout'

const connections = [
  ['a', 'b'],
  ['b', 'c'],
  ['b', 'd'],
  ['d', 'a'],
  ['a', 'd'],
  ['b', 'a'],
  ['c', 'b'],
].map(([source, target]) => ({ id: `${source}:${target}`, source, target }))

describe('dependency routing', () => {
  it('should support an empty filtered view', () => {
    expect(layoutGraph([], [], { rankdir: 'TB' })).toEqual({ nodes: {}, links: [] })
  })
  it('should give reciprocal connections distinct ports facing the other card', () => {
    const graph = layoutGraph(
      [
        { id: 'a', width: 240, height: 120 },
        { id: 'b', width: 240, height: 180 },
      ],
      [
        { id: 'a:b', source: 'a', target: 'b' },
        { id: 'b:a', source: 'b', target: 'a' },
      ],
      { rankdir: 'TB', ranksep: 80 },
    )
    const forward = graph.links[0]
    const reverse = graph.links[1]
    expect(graph.nodes.a.position.y).toBeLessThan(graph.nodes.b.position.y)
    expect(
      graph.nodes.b.ports.find((port) => port.id === reverse.sourceHandle)?.side,
    ).toBe('top')
    expect(
      graph.nodes.a.ports.find((port) => port.id === reverse.targetHandle)?.side,
    ).toBe('bottom')
    expect(forward.points[0]).not.toEqual(reverse.points[reverse.points.length - 1])
    expect(forward.points[forward.points.length - 1]).not.toEqual(reverse.points[0])
  })

  it.each([
    { width: 240, direction: 'TB' as const },
    { width: 156, direction: 'TB' as const },
    { width: 240, direction: 'LR' as const },
  ])(
    'should route around measured cards at $width px in $direction layout',
    ({ width, direction }) => {
      const graph = layoutGraph(
        ['a', 'b', 'c', 'd'].map((id, index) => ({
          id,
          width,
          height: [128, 240, 160, 320][index],
        })),
        connections,
        { rankdir: direction, nodesep: 56, ranksep: 80 },
      )
      expect(
        graph.links.map(({ id, source, target }) => ({ id, source, target })),
      ).toEqual(connections)
      graph.links.forEach((link) => {
        expect(link.path).not.toMatch(/NaN|undefined|Infinity/)
        const source = graph.nodes[link.source]
        const target = graph.nodes[link.target]
        const sourcePort = source.ports.find((port) => port.id === link.sourceHandle)!
        const targetPort = target.ports.find((port) => port.id === link.targetHandle)!
        expect(sourcePort.type).toBe('source')
        expect(targetPort.type).toBe('target')
        expect(source.position.x + sourcePort.x).toBeCloseTo(link.points[0].x)
        expect(source.position.y + sourcePort.y).toBeCloseTo(link.points[0].y)
        expect(target.position.x + targetPort.x).toBeCloseTo(link.points.at(-1)!.x)
        expect(target.position.y + targetPort.y).toBeCloseTo(link.points.at(-1)!.y)
        link.points.slice(1).forEach((point, index) => {
          const previous = link.points[index]
          Array.from({ length: 101 }, (_, sample) => sample / 100).forEach((fraction) => {
            const x = previous.x + (point.x - previous.x) * fraction
            const y = previous.y + (point.y - previous.y) * fraction
            Object.values(graph.nodes).forEach((node) => {
              const inside =
                x > node.position.x + 0.01 &&
                x < node.position.x + node.width - 0.01 &&
                y > node.position.y + 0.01 &&
                y < node.position.y + node.height - 0.01
              expect(inside, `${link.id} crosses ${node.id}`).toBe(false)
            })
          })
        })
      })
    },
  )

  it('should keep isolated cards without inventing links or ports', () => {
    const graph = layoutGraph([{ id: 'alone', width: 156, height: 224 }], [], {
      rankdir: 'TB',
    })
    expect(graph.links).toEqual([])
    expect(graph.nodes.alone.ports).toEqual([])
  })

  it('should keep reciprocal runs separate when workstreams are staggered', () => {
    const graph = layoutGraph(
      ['a', 'b', 'c', 'd'].map((id, index) => ({
        id,
        width: 240,
        height: index % 2 ? 155 : 125,
      })),
      connections,
      { rankdir: 'TB', nodesep: 56, ranksep: 80 },
    )
    expect(graph.nodes.a.position.x).not.toBe(graph.nodes.b.position.x)
    const runs = (points: { x: number; y: number }[]) =>
      points.slice(1).flatMap((point, index) => {
        const previous = points[index]
        return previous.y === point.y && previous.x !== point.x
          ? [
              {
                y: point.y,
                start: Math.min(previous.x, point.x),
                end: Math.max(previous.x, point.x),
              },
            ]
          : []
      })
    graph.links.forEach((link) => {
      const reverse = graph.links.find(
        (candidate) =>
          candidate.source === link.target && candidate.target === link.source,
      )
      if (!reverse) return
      for (const forwardRun of runs(link.points)) {
        for (const reverseRun of runs(reverse.points)) {
          const overlaps =
            forwardRun.y === reverseRun.y &&
            Math.max(forwardRun.start, reverseRun.start) <
              Math.min(forwardRun.end, reverseRun.end)
          expect(overlaps, `${link.id} shares a run with ${reverse.id}`).toBe(false)
        }
      }
    })
  })

  it.each(['TB', 'LR'] as const)(
    'should keep wide fan-out links clear of neighbouring cards in %s layout',
    (rankdir) => {
      const nodes = Array.from({ length: 32 }, (_, index) => ({
        id: `step-${index}`,
        width: 240,
        height: 112 + (index % 4) * 24,
      }))
      const links = nodes.slice(8).flatMap((node, index) =>
        [...new Set([index, (index * 3) % 8, ...(index >= 8 ? [index - 3] : [])])].map(
          (source) => ({
            id: `${source}:${node.id}`,
            source: `step-${source}`,
            target: node.id,
          }),
        ),
      )
      const graph = layoutGraph(nodes, links, { rankdir, nodesep: 56, ranksep: 56 })
      graph.links.forEach((link) => {
        link.points.slice(1).forEach((point, index) => {
          const previous = link.points[index]
          for (let fraction = 0; fraction <= 1; fraction += 0.01) {
            const x = previous.x + (point.x - previous.x) * fraction
            const y = previous.y + (point.y - previous.y) * fraction
            Object.values(graph.nodes).forEach((node) => {
              expect(
                x > node.position.x + 0.01 &&
                  x < node.position.x + node.width - 0.01 &&
                  y > node.position.y + 0.01 &&
                  y < node.position.y + node.height - 0.01,
                `${link.id} crosses ${node.id}`,
              ).toBe(false)
            })
          }
        })
      })
    },
  )
})
