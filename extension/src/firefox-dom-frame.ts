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

const USED_LENGTH = /^(?:\d+|\d*\.\d+)px$/

function usedLengthPixels(options: { value: string; label: string }): number {
  const value = options.value.trim()
  if (!USED_LENGTH.test(value))
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: `Firefox frame actions without getBoxQuads need a resolvable used ${options.label}; got ${JSON.stringify(options.value)}.`,
    })
  const pixels = Number.parseFloat(value)
  if (!Number.isFinite(pixels) || pixels < 0)
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: `Firefox frame actions without getBoxQuads need a finite non-negative ${options.label}.`,
    })
  return pixels
}

function isIdentityMatrix(value: string): boolean {
  const normalized = value.trim()
  const matrix = /^matrix\(([^)]*)\)$/.exec(normalized)
  if (matrix) {
    const entries = matrix[1].split(',').map((entry) => {
      return Number(entry.trim())
    })
    return (
      entries.length === 6 &&
      entries[0] === 1 &&
      entries[1] === 0 &&
      entries[2] === 0 &&
      entries[3] === 1 &&
      entries[4] === 0 &&
      entries[5] === 0
    )
  }
  const matrix3d = /^matrix3d\(([^)]*)\)$/.exec(normalized)
  if (matrix3d) {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const entries = matrix3d[1].split(',').map((entry) => {
      return Number(entry.trim())
    })
    return entries.length === 16 && entries.every((entry, index) => entry === identity[index])
  }
  return false
}

function isNeutralLengths(value: string): boolean {
  const normalized = value.trim()
  if (normalized === 'none') return true
  const parts = normalized.split(/\s+/)
  return parts.length > 0 && parts.every((part) => /^0(?:px|%)?$/.test(part))
}

function isNeutralScale(value: string): boolean {
  const normalized = value.trim()
  if (normalized === 'none') return true
  const parts = normalized.split(/\s+/)
  return parts.length > 0 && parts.every((part) => part === '1')
}

function isNeutralZoom(value: string): boolean {
  const normalized = value.trim()
  if (normalized === '' || normalized === 'normal') return true
  if (normalized.endsWith('%')) return Number.parseFloat(normalized) === 100
  return Number.parseFloat(normalized) === 1
}

export function assertStaticFrameTransform(options: {
  transform: string
  rotate: string
  scale: string
  translate: string
  zoom: string
  perspective: string
  offsetPath: string
}): void {
  if (!options.transform || options.transform.trim() === '' || options.transform.trim() === 'none') {
    // An untransformed box keeps the client rect aligned with layout coordinates.
  } else if (!isIdentityMatrix(options.transform)) {
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message:
        'Firefox frame actions without getBoxQuads cannot prove an axis-aligned frame under a non-identity transform.',
    })
  }
  if (options.perspective && options.perspective !== 'none')
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads cannot map perspective transforms.',
    })
  if (options.offsetPath && options.offsetPath !== 'none')
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads cannot map motion paths.',
    })
  if (options.rotate && options.rotate !== 'none' && !/^0(?:deg|grad|rad|turn)?$/.test(options.rotate.trim()))
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads cannot map an independent rotation.',
    })
  if (options.scale && !isNeutralScale(options.scale))
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads cannot map an independent scale.',
    })
  if (options.translate && !isNeutralLengths(options.translate))
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads cannot map an independent translation.',
    })
  if (options.zoom && !isNeutralZoom(options.zoom))
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads cannot map page zoom.',
    })
}

export function frameContentQuad(options: {
  box: { left: number; top: number; width: number; height: number }
  client: { left: number; top: number; width: number; height: number }
  border: { left: number; right: number; top: number; bottom: number }
  padding: { left: number; right: number; top: number; bottom: number }
}): { quad: FrameContentQuad; viewport: { width: number; height: number } } {
  const { box, client, border, padding } = options
  if (
    ![box.left, box.top, box.width, box.height].every((entry) => {
      return Number.isFinite(entry)
    }) ||
    box.width <= 0 ||
    box.height <= 0
  )
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads require a finite, non-degenerate frame box.',
    })
  if (client.left !== border.left || client.top !== border.top)
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message:
        'Firefox frame actions without getBoxQuads cannot prove the frame border because the rounded client offset disagrees with the used border width.',
    })
  if (
    box.width !== border.left + client.width + border.right ||
    box.height !== border.top + client.height + border.bottom
  )
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message:
        'Firefox frame actions without getBoxQuads cannot prove the frame content box because the border box, client box, and used borders disagree.',
    })
  const contentWidth = client.width - padding.left - padding.right
  const contentHeight = client.height - padding.top - padding.bottom
  if (!(contentWidth > 0) || !(contentHeight > 0))
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads require a provable positive content box.',
    })
  const left = box.left + border.left + padding.left
  const top = box.top + border.top + padding.top
  return {
    quad: {
      p1: { x: left, y: top },
      p2: { x: left + contentWidth, y: top },
      p3: { x: left + contentWidth, y: top + contentHeight },
      p4: { x: left, y: top + contentHeight },
    },
    viewport: { width: contentWidth, height: contentHeight },
  }
}

export function untransformedFrameContentBox(options: { frame: Element }): {
  quad: FrameContentQuad
  viewport: { width: number; height: number }
} {
  const { frame } = options
  const view = frame.ownerDocument.defaultView
  if (!view) throw new FirefoxDomError({ message: 'The ancestor frame has no active parent document.' })
  const rects = frame.getClientRects()
  if (rects.length !== 1)
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message: 'Firefox frame actions without getBoxQuads require a single unfragmented frame box.',
    })
  const rect = rects[0]
  const style = view.getComputedStyle(frame)
  return frameContentQuad({
    box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    client: { left: frame.clientLeft, top: frame.clientTop, width: frame.clientWidth, height: frame.clientHeight },
    border: {
      left: usedLengthPixels({ value: style.borderLeftWidth, label: 'border-left-width' }),
      right: usedLengthPixels({ value: style.borderRightWidth, label: 'border-right-width' }),
      top: usedLengthPixels({ value: style.borderTopWidth, label: 'border-top-width' }),
      bottom: usedLengthPixels({ value: style.borderBottomWidth, label: 'border-bottom-width' }),
    },
    padding: {
      left: usedLengthPixels({ value: style.paddingLeft, label: 'padding-left' }),
      right: usedLengthPixels({ value: style.paddingRight, label: 'padding-right' }),
      top: usedLengthPixels({ value: style.paddingTop, label: 'padding-top' }),
      bottom: usedLengthPixels({ value: style.paddingBottom, label: 'padding-bottom' }),
    },
  })
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
  const geometry = frame as Element & { getBoxQuads?: (options: { box: 'content' }) => FrameContentQuad[] }
  let quad: FrameContentQuad
  let viewport: { width: number; height: number }
  if (typeof geometry.getBoxQuads === 'function') {
    for (let current: Element | null = frame; current; current = composedParent(current)) {
      const style = view.getComputedStyle(current)
      assertFrameTransform({
        transform: style.transform,
        rotate: style.rotate,
        perspective: style.perspective,
        offsetPath: style.offsetPath,
      })
    }
    const quads = geometry.getBoxQuads({ box: 'content' })
    if (quads.length !== 1)
      throw new FirefoxDomError({
        code: 'unsupported-capability',
        message: 'The ancestor frame does not have exactly one content quad.',
      })
    const style = view.getComputedStyle(frame)
    const paddingX = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0')
    const paddingY = Number.parseFloat(style.paddingTop || '0') + Number.parseFloat(style.paddingBottom || '0')
    quad = quads[0]
    viewport = { width: frame.clientWidth - paddingX, height: frame.clientHeight - paddingY }
  } else {
    for (let current: Element | null = frame; current; current = composedParent(current)) {
      const style = view.getComputedStyle(current)
      assertStaticFrameTransform({
        transform: style.transform,
        rotate: style.rotate,
        scale: style.scale,
        translate: style.translate,
        zoom: style.zoom,
        perspective: style.perspective,
        offsetPath: style.offsetPath,
      })
    }
    const box = untransformedFrameContentBox({ frame })
    quad = box.quad
    viewport = box.viewport
  }
  const point = mapFramePoint({ point: options.point, quad, viewport })
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
