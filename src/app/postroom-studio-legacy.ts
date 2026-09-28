import { toUint8Array } from 'js-base64'

import { FigmaAPI } from '@open-pencil/core/figma-api'
import type { SceneNode } from '@open-pencil/scene-graph'
import type { Rect } from '@open-pencil/scene-graph/primitives'

import type { EditorStore } from '@/app/editor/session'

interface LegacyImageLayer extends Rect {
  name: 'IMAGE_SLOT'
  borderRadius: number
}

interface LegacyTextLayer extends Rect {
  name: 'SCRIPT_TEXT'
  fontSize: number
  fontWeight: number
  textAlign: 'left' | 'center' | 'right'
  verticalAlign: 'top' | 'middle' | 'bottom'
  textTransform: 'none' | 'uppercase' | 'lowercase'
  color: { hex: string }
}

interface LegacyDesign {
  format: Pick<Rect, 'width' | 'height'>
  layers: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const result = value[key]
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new TypeError(`This saved template has an invalid ${key} value.`)
  }
  return result
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key]
  if (typeof result !== 'string')
    throw new TypeError(`This saved template has an invalid ${key} value.`)
  return result
}

function parseDesign(value: unknown): {
  design: LegacyDesign
  image: LegacyImageLayer
  text: LegacyTextLayer
} {
  if (!isRecord(value) || !isRecord(value.format) || !Array.isArray(value.layers)) {
    throw new Error('This saved template cannot be opened in OpenPencil.')
  }
  const design: LegacyDesign = {
    format: {
      width: requiredNumber(value.format, 'width'),
      height: requiredNumber(value.format, 'height')
    },
    layers: value.layers
  }
  const imageRecord = value.layers.find((layer) => isRecord(layer) && layer.name === 'IMAGE_SLOT')
  const textRecord = value.layers.find((layer) => isRecord(layer) && layer.name === 'SCRIPT_TEXT')
  if (!isRecord(imageRecord) || !isRecord(textRecord)) {
    throw new Error('This saved template is missing its marked image or text area.')
  }
  const image: LegacyImageLayer = {
    name: 'IMAGE_SLOT',
    x: requiredNumber(imageRecord, 'x'),
    y: requiredNumber(imageRecord, 'y'),
    width: requiredNumber(imageRecord, 'width'),
    height: requiredNumber(imageRecord, 'height'),
    borderRadius: typeof imageRecord.borderRadius === 'number' ? imageRecord.borderRadius : 0
  }
  const rawColor = isRecord(textRecord.color) ? requiredString(textRecord.color, 'hex') : '#ffffff'
  if (!/^#[\da-fA-F]{6}$/.test(rawColor))
    throw new Error('This saved template has an invalid text color.')
  const align = textRecord.textAlign
  const verticalAlign = textRecord.verticalAlign
  const transform = textRecord.textTransform
  const text: LegacyTextLayer = {
    name: 'SCRIPT_TEXT',
    x: requiredNumber(textRecord, 'x'),
    y: requiredNumber(textRecord, 'y'),
    width: requiredNumber(textRecord, 'width'),
    height: requiredNumber(textRecord, 'height'),
    fontSize: requiredNumber(textRecord, 'fontSize'),
    fontWeight: typeof textRecord.fontWeight === 'number' ? textRecord.fontWeight : 700,
    textAlign: align === 'left' || align === 'right' ? align : 'center',
    verticalAlign: verticalAlign === 'middle' || verticalAlign === 'bottom' ? verticalAlign : 'top',
    textTransform: transform === 'uppercase' || transform === 'lowercase' ? transform : 'none',
    color: { hex: rawColor }
  }
  return { design, image, text }
}

function decodeBase64(value: string): Uint8Array {
  try {
    return toUint8Array(value)
  } catch {
    throw new Error('This saved template contains an invalid image layer.')
  }
}

function horizontalAlignment(
  value: LegacyTextLayer['textAlign']
): SceneNode['textAlignHorizontal'] {
  if (value === 'left') return 'LEFT'
  if (value === 'right') return 'RIGHT'
  return 'CENTER'
}

function verticalAlignment(
  value: LegacyTextLayer['verticalAlign']
): SceneNode['textAlignVertical'] {
  if (value === 'middle') return 'CENTER'
  if (value === 'bottom') return 'BOTTOM'
  return 'TOP'
}

function textCase(value: LegacyTextLayer['textTransform']): SceneNode['textCase'] {
  if (value === 'uppercase') return 'UPPER'
  if (value === 'lowercase') return 'LOWER'
  return 'ORIGINAL'
}

export function loadLegacyTemplate(
  store: EditorStore,
  rawDesign: unknown,
  rawLayers: unknown,
  createFrame: (
    store: EditorStore,
    width: number,
    height: number,
    name: string,
    addBackground?: boolean
  ) => SceneNode
): SceneNode {
  const { design, image, text } = parseDesign(rawDesign)
  const layers = isRecord(rawLayers) ? rawLayers : {}
  const frame = createFrame(
    store,
    design.format.width,
    design.format.height,
    'Imported template',
    false
  )
  const figma = new FigmaAPI(store.graph)
  const addOverlay = (name: string, base64: unknown) => {
    if (typeof base64 !== 'string' || !base64) return
    const imageHash = figma.createImage(decodeBase64(base64)).hash
    store.graph.createNode('RECTANGLE', frame.id, {
      name,
      x: 0,
      y: 0,
      width: frame.width,
      height: frame.height,
      fills: [
        {
          type: 'IMAGE',
          color: { r: 1, g: 1, b: 1, a: 1 },
          imageHash,
          imageScaleMode: 'FILL',
          visible: true,
          opacity: 1
        }
      ]
    })
  }

  addOverlay('Imported base overlay', layers.base)
  store.graph.createNode('RECTANGLE', frame.id, {
    name: 'IMAGE_SLOT',
    x: image.x,
    y: image.y,
    width: image.width,
    height: image.height,
    cornerRadius: image.borderRadius,
    fills: []
  })
  addOverlay('Imported middle overlay', layers.middle)

  const hex = text.color.hex.slice(1)
  const color = {
    r: Number.parseInt(hex.slice(0, 2), 16) / 255,
    g: Number.parseInt(hex.slice(2, 4), 16) / 255,
    b: Number.parseInt(hex.slice(4, 6), 16) / 255,
    a: 1
  }
  store.graph.createNode('TEXT', frame.id, {
    name: 'SCRIPT_TEXT',
    x: text.x,
    y: text.y,
    width: text.width,
    height: text.height,
    text: 'Sample script',
    fontSize: text.fontSize,
    fontFamily: 'Inter',
    fontWeight: text.fontWeight,
    textAlignHorizontal: horizontalAlignment(text.textAlign),
    textAlignVertical: verticalAlignment(text.verticalAlign),
    textCase: textCase(text.textTransform),
    fills: [{ type: 'SOLID', color, opacity: 1, visible: true }]
  })
  addOverlay('Imported top overlay', layers.top)
  return frame
}
