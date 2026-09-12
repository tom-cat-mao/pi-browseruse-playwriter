import { FirefoxDomError, composedParent, isVisible } from './firefox-dom-locators'

export interface FramePoint {
  x: number
  y: number
}

export interface FrameContentQuad {
  p1: FramePoint
  p2: FramePoint
  p3: FramePoint
  p4: FramePoint
}

const EPSILON = 0.000_001

export function mapFramePoint(options: {
  point: FramePoint
  quad: FrameContentQuad
  viewport: { width: number; height: number }
}): FramePoint {
  const { point, quad, viewport } = options
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    point.x >= viewport.width ||
    point.y >= viewport.height
  ) {
    throw new FirefoxDomError({ message: 'The prepared action point is outside the child frame viewport.' })
  }
  const values = [quad.p1, quad.p2, quad.p3, quad.p4].flatMap((entry) => {
    return [entry.x, entry.y]
  })
  if (
    !values.every((entry) => {
      return Number.isFinite(entry)
    }) ||
    Math.abs(quad.p1.y - quad.p2.y) > EPSILON ||
    Math.abs(quad.p4.y - quad.p3.y) > EPSILON ||
    Math.abs(quad.p1.x - quad.p4.x) > EPSILON ||
    Math.abs(quad.p2.x - quad.p3.x) > EPSILON ||
    quad.p2.x <= quad.p1.x ||
    quad.p4.y <= quad.p1.y
  ) {
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox DOM actions cannot safely map rotated, skewed, reflected, or perspective-transformed frames.',
    })
  }
  return {
    x: quad.p1.x + (point.x * (quad.p2.x - quad.p1.x)) / viewport.width,
    y: quad.p1.y + (point.y * (quad.p4.y - quad.p1.y)) / viewport.height,
  }
}

export function assertFrameTransform(options: {
  transform: string
  rotate: string
  perspective: string
  offsetPath: string
}): void {
  if (
    (options.rotate && options.rotate !== 'none' && !/^0(?:deg|grad|rad|turn)?$/.test(options.rotate)) ||
    (options.perspective && options.perspective !== 'none') ||
    (options.offsetPath && options.offsetPath !== 'none')
  ) {
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox DOM frame actions require axis-aligned frames without rotation, motion paths, or perspective.',
    })
  }
  if (!options.transform || options.transform === 'none') return
  const match = /^matrix\(([^)]+)\)$/.exec(options.transform)
  const matrix = match?.[1].split(',').map((entry) => {
    return Number(entry.trim())
  })
  if (
    !matrix ||
    matrix.length !== 6 ||
    !matrix.every((entry) => {
      return Number.isFinite(entry)
    }) ||
    matrix[0] <= 0 ||
    matrix[3] <= 0 ||
    Math.abs(matrix[1]) > EPSILON ||
    Math.abs(matrix[2]) > EPSILON
  ) {
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox DOM frame actions cannot map rotation, skew, reflection, or 3D transforms safely.',
    })
  }
}

function composedContains(options: { element: Element; ancestor: Element }): boolean {
  for (let current: Element | null = options.element; current; current = composedParent(current)) {
    if (current === options.ancestor) return true
  }
  return false
}

export function checkFramePoint(options: { frame: Element; point: FramePoint }): FramePoint {
  const { frame } = options
  if (!['iframe', 'frame'].includes(frame.localName))
    throw new FirefoxDomError({ message: 'The frame selector does not identify an iframe or frame element.' })
  if (!isVisible(frame)) throw new FirefoxDomError({ message: 'The ancestor frame is detached or not visible.' })
  const view = frame.ownerDocument.defaultView
  if (!view) throw new FirefoxDomError({ message: 'The ancestor frame has no active parent document.' })
  for (let current: Element | null = frame; current; current = composedParent(current)) {
    const style = view.getComputedStyle(current)
    assertFrameTransform({
      transform: style.transform,
      rotate: style.rotate,
      perspective: style.perspective,
      offsetPath: style.offsetPath,
    })
  }
  const geometry = frame as Element & { getBoxQuads?: (options: { box: 'content' }) => FrameContentQuad[] }
  if (!geometry.getBoxQuads)
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message:
        'Firefox getBoxQuads is required to verify the frame content box; no bounding-box approximation is used.',
    })
  const quads = geometry.getBoxQuads({ box: 'content' })
  if (quads.length !== 1)
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'The ancestor frame does not have exactly one content quad.',
    })
  const style = view.getComputedStyle(frame)
  const paddingX = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0')
  const paddingY = Number.parseFloat(style.paddingTop || '0') + Number.parseFloat(style.paddingBottom || '0')
  const point = mapFramePoint({
    point: options.point,
    quad: quads[0],
    viewport: { width: frame.clientWidth - paddingX, height: frame.clientHeight - paddingY },
  })
  if (point.x < 0 || point.y < 0 || point.x >= view.innerWidth || point.y >= view.innerHeight)
    throw new FirefoxDomError({ message: 'The prepared action point is outside an ancestor frame viewport.' })
  let hit = frame.ownerDocument.elementFromPoint(point.x, point.y)
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(point.x, point.y)
    if (!inner || inner === hit) break
    hit = inner
  }
  if (!hit || !composedContains({ ancestor: frame, element: hit }))
    throw new FirefoxDomError({
      message: `The prepared action point is covered in an ancestor document by ${hit ? `<${hit.localName}>` : 'another surface'}.`,
    })
  return point
}
