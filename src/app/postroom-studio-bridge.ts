import {
  computeContentBounds,
  exportFigFile,
  extractExportGraph,
  renderNodesToImage
} from '@open-pencil/core/io'
import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'
import type { Color, Rect, Vector } from '@open-pencil/scene-graph/primitives'

import type { EditorStore } from '@/app/editor/session'
import { importStudioSlides, type StudioSlide } from '@/app/postroom-studio-import'
import { loadLegacyTemplate } from '@/app/postroom-studio-legacy'
import { openFileInNewTab } from '@/app/tabs'

interface TemplateOverlay {
  data: Uint8Array
  x: number
  y: number
}

interface TemplateLayerBase extends Rect {
  id: string
  rotation: number
  zIndex: number
}

interface TemplateImageLayer extends TemplateLayerBase {
  name: 'IMAGE_SLOT'
  type: 'image'
  fit: 'cover' | 'contain' | 'fill'
  cropX: number
  cropY: number
  cropW: number
  cropH: number
  borderRadius: number
}

interface TemplateTextLayer extends TemplateLayerBase {
  name: 'SCRIPT_TEXT'
  type: 'text'
  fontSize: number
  fontWeight: number
  textAlign: 'left' | 'center' | 'right'
  verticalAlign: 'top' | 'middle' | 'bottom'
  textTransform: 'none' | 'uppercase' | 'lowercase'
  color: { hex: string }
}

interface TemplateGuideLayer extends TemplateLayerBase {
  name: 'POSTROOM_SAFE_ZONE'
}

interface TemplateDocument {
  format: Pick<Rect, 'width' | 'height'>
  layers: (TemplateImageLayer | TemplateTextLayer | TemplateGuideLayer)[]
}

type CommandArgs = Record<string, unknown>
type CommandHandler = (store: EditorStore, command: CommandArgs) => Promise<unknown>

let templateFrameId: string | null = null
let previewOriginal: { id: string; text: string } | null = null

function reply(
  id: number,
  result: { ok: true; result: unknown } | { ok: false; error: string }
): void {
  window.parent.postMessage(
    { source: 'openpencil', type: 'command-result', id, result },
    window.location.origin
  )
}

function frameAncestor(graph: SceneGraph, node: SceneNode): SceneNode | undefined {
  let parent = node.parentId ? graph.getNode(node.parentId) : undefined
  while (parent && parent.type !== 'FRAME') {
    parent = parent.parentId ? graph.getNode(parent.parentId) : undefined
  }
  return parent
}

function selectedNode(store: EditorStore): SceneNode | undefined {
  const selectedIds = [...store.state.selectedIds]
  if (selectedIds.length !== 1) return undefined
  return store.graph.getNode(selectedIds[0])
}

function frameFor(store: EditorStore, selected?: SceneNode): SceneNode | undefined {
  const graph = store.graph
  let selectedFrame: SceneNode | undefined
  if (selected?.type === 'FRAME') selectedFrame = selected
  else if (selected) selectedFrame = frameAncestor(graph, selected)

  const stored = templateFrameId ? graph.getNode(templateFrameId) : undefined
  const storedFrame = stored?.type === 'FRAME' ? stored : undefined
  const frames = graph
    .getChildren(store.state.currentPageId)
    .filter((node) => node.type === 'FRAME')
  const frameWithSlots = frames.find((frame) => {
    const names = new Set(graph.getChildren(frame.id).map((node) => node.name))
    return names.has('IMAGE_SLOT') && names.has('SCRIPT_TEXT')
  })
  const frame = selectedFrame ?? storedFrame ?? frameWithSlots
  if (frame) templateFrameId = frame.id
  return frame
}

function clearSelection(store: EditorStore, selectId?: string): void {
  store.state.selectedIds.clear()
  if (selectId) store.state.selectedIds.add(selectId)
}

function addFrame(
  store: EditorStore,
  width: number,
  height: number,
  name: string,
  addBackground = true
): SceneNode {
  const graph = store.graph
  const frameCount = graph
    .getChildren(store.state.currentPageId)
    .filter((node) => node.type === 'FRAME').length
  const frame = graph.createNode('FRAME', store.state.currentPageId, {
    name,
    width,
    height,
    clipsContent: true,
    fills: [],
    x: 0,
    y: frameCount * (height + 80)
  })
  if (addBackground) {
    graph.createNode('RECTANGLE', frame.id, {
      name: 'Background',
      x: 0,
      y: 0,
      width,
      height,
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }]
    })
  }
  clearSelection(store, frame.id)
  return frame
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function resetPreview(store: EditorStore): void {
  if (!previewOriginal) return
  store.updateNodeWithUndo(
    previewOriginal.id,
    { text: previewOriginal.text },
    'Reset script preview'
  )
  previewOriginal = null
}

function colorToHex(color: Color): string {
  return `#${[color.r, color.g, color.b]
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value * 255)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function textAlignment(value: SceneNode['textAlignHorizontal']): TemplateTextLayer['textAlign'] {
  if (value === 'LEFT') return 'left'
  if (value === 'RIGHT') return 'right'
  return 'center'
}

function verticalAlignment(
  value: SceneNode['textAlignVertical']
): TemplateTextLayer['verticalAlign'] {
  if (value === 'CENTER') return 'middle'
  if (value === 'BOTTOM') return 'bottom'
  return 'top'
}

function textTransform(value: SceneNode['textCase']): TemplateTextLayer['textTransform'] {
  if (value === 'UPPER') return 'uppercase'
  if (value === 'LOWER') return 'lowercase'
  return 'none'
}

function renderOverlay(
  store: EditorStore,
  ids: string[],
  framePosition: Vector
): TemplateOverlay | null {
  if (!ids.length || !store.renderer) return null
  const bounds = computeContentBounds(store.graph, ids)
  if (!bounds) return null
  const data = renderNodesToImage(
    store.renderer.ck,
    store.renderer,
    store.graph,
    store.state.currentPageId,
    ids,
    { scale: 1, format: 'PNG', trimTransparent: false }
  )
  return data ? { data, x: bounds.minX - framePosition.x, y: bounds.minY - framePosition.y } : null
}

async function exportTemplate(store: EditorStore): Promise<unknown> {
  resetPreview(store)
  const graph = store.graph
  const frame = frameFor(store, selectedNode(store))
  if (!frame) throw new Error('Select or create the frame you want to save.')
  const children = graph.getChildren(frame.id)
  const image = children.find((node) => node.name === 'IMAGE_SLOT')
  const text = children.find((node) => node.name === 'SCRIPT_TEXT')
  if (!image || !text)
    throw new Error('Mark one image area and one text area inside the selected frame.')
  if (
    image.parentId !== frame.id ||
    text.parentId !== frame.id ||
    image.rotation ||
    text.rotation
  ) {
    throw new Error(
      'Keep the marked image and text areas as unrotated layers directly inside the frame.'
    )
  }
  const imageZ = frame.childIds.indexOf(image.id)
  const textZ = frame.childIds.indexOf(text.id)
  if (imageZ >= textZ) throw new Error('Move the image area behind the text area before saving.')

  const design: TemplateDocument = {
    format: { width: Math.round(frame.width), height: Math.round(frame.height) },
    layers: [
      {
        id: image.id,
        name: 'IMAGE_SLOT',
        type: 'image',
        x: image.x,
        y: image.y,
        width: image.width,
        height: image.height,
        rotation: image.rotation,
        zIndex: imageZ,
        fit:
          image.fills.find((fill) => fill.type === 'IMAGE')?.imageScaleMode === 'FIT'
            ? 'contain'
            : 'cover',
        cropX: 0,
        cropY: 0,
        cropW: 1,
        cropH: 1,
        borderRadius: image.cornerRadius
      },
      {
        id: text.id,
        name: 'SCRIPT_TEXT',
        type: 'text',
        x: text.x,
        y: text.y,
        width: text.width,
        height: text.height,
        rotation: text.rotation,
        zIndex: textZ,
        fontSize: text.fontSize,
        fontWeight: text.fontWeight,
        textAlign: textAlignment(text.textAlignHorizontal),
        verticalAlign: verticalAlignment(text.textAlignVertical),
        textTransform: textTransform(text.textCase),
        color: {
          hex: colorToHex(
            text.fills.find((fill) => fill.visible)?.color ?? { r: 1, g: 1, b: 1, a: 1 }
          )
        }
      }
    ]
  }
  const guide = children.find((node) => node.name === 'POSTROOM_SAFE_ZONE')
  if (guide) {
    design.layers.push({
      id: guide.id,
      name: 'POSTROOM_SAFE_ZONE',
      x: guide.x,
      y: guide.y,
      width: guide.width,
      height: guide.height,
      rotation: guide.rotation,
      zIndex: frame.childIds.indexOf(guide.id)
    })
  }

  const visibleChildren = children.filter(
    (node) => node.visible && node.name !== 'POSTROOM_SAFE_ZONE'
  )
  const overlayIds = (from: number, to: number) =>
    visibleChildren
      .filter((node) => {
        const index = frame.childIds.indexOf(node.id)
        return index >= from && index < to
      })
      .map((node) => node.id)
  const framePosition = graph.getAbsolutePosition(frame.id)
  const overlays = [
    renderOverlay(store, overlayIds(0, imageZ), framePosition),
    renderOverlay(store, overlayIds(imageZ + 1, textZ), framePosition),
    renderOverlay(store, overlayIds(textZ + 1, frame.childIds.length), framePosition)
  ] satisfies (TemplateOverlay | null)[]
  const source = extractExportGraph(graph, { scope: 'selection', nodeIds: [frame.id] })
  const fig = await exportFigFile(
    source.graph,
    store.renderer?.ck,
    store.renderer ?? undefined,
    source.pageId ?? undefined
  )
  return { document: design, overlays, fig }
}

function toggleSafeZone(store: EditorStore): { message: string } {
  const graph = store.graph
  const frame = frameFor(store, selectedNode(store))
  if (!frame) throw new Error('Create or select a frame first.')
  const existing = graph.getChildren(frame.id).find((node) => node.name === 'POSTROOM_SAFE_ZONE')
  if (existing) {
    graph.deleteNode(existing.id)
    return { message: 'TikTok guide hidden.' }
  }
  graph.createNode('RECTANGLE', frame.id, {
    name: 'POSTROOM_SAFE_ZONE',
    x: frame.width * 0.08,
    y: frame.height * 0.12,
    width: frame.width * 0.78,
    height: frame.height * 0.66,
    fills: [
      { type: 'SOLID', color: { r: 0.1, g: 0.8, b: 0.55, a: 1 }, opacity: 0.18, visible: true }
    ]
  })
  return { message: 'TikTok guide shown. Keep text inside the green area.' }
}

function markSlot(store: EditorStore, kind: 'image' | 'text'): { message: string } {
  const selected = selectedNode(store)
  const type = kind === 'image' ? 'RECTANGLE' : 'TEXT'
  const name = kind === 'image' ? 'IMAGE_SLOT' : 'SCRIPT_TEXT'
  if (!selected || selected.type !== type) {
    throw new Error(`Select one ${kind === 'image' ? 'rectangle' : 'text'} layer first.`)
  }
  const frame = frameAncestor(store.graph, selected)
  if (!frame) throw new Error('Place the selected layer inside a frame first.')
  templateFrameId = frame.id
  for (const node of store.graph.getChildren(frame.id)) {
    if (node.name === name && node.id !== selected.id) {
      store.updateNodeWithUndo(
        node.id,
        { name: kind === 'text' ? 'Text' : 'Image' },
        'Clear template slot'
      )
    }
  }
  store.updateNodeWithUndo(selected.id, { name }, 'Mark template slot')
  return { message: `${kind === 'image' ? 'Image' : 'Text'} area marked.` }
}

function previewScript(store: EditorStore, command: CommandArgs): { message: string } {
  resetPreview(store)
  const frame = frameFor(store, selectedNode(store))
  const node =
    frame && store.graph.getChildren(frame.id).find((item) => item.name === 'SCRIPT_TEXT')
  if (!node) throw new Error('Mark a text layer first.')
  previewOriginal = { id: node.id, text: node.text }
  const previewText = typeof command.text === 'string' ? command.text : 'Sample script'
  store.updateNodeWithUndo(node.id, { text: previewText }, 'Preview script')
  return { message: 'Sample script previewed.' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStudioSlide(value: unknown): value is StudioSlide {
  if (!isRecord(value) || !isRecord(value.textBox)) return false
  const box = value.textBox
  const numbers = [value.width, value.height, box.x, box.y, box.width, box.height]
  return (
    typeof value.name === 'string' &&
    typeof value.imageUrl === 'string' &&
    typeof value.text === 'string' &&
    numbers.every((number) => typeof number === 'number' && Number.isFinite(number))
  )
}

function parseStudioSlides(value: unknown): StudioSlide[] {
  if (!Array.isArray(value) || !value.every(isStudioSlide)) {
    throw new Error('The slide import data is incomplete.')
  }
  return value
}

function commandString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function addFrameCommand(store: EditorStore): { message: string } {
  const frame = addFrame(store, 1080, 1920, 'TikTok 9:16')
  templateFrameId = frame.id
  return { message: '9:16 frame added.' }
}

async function importSlidesCommand(
  store: EditorStore,
  command: CommandArgs
): Promise<{ message: string }> {
  const frames = await importStudioSlides(store, parseStudioSlides(command.slides))
  templateFrameId = frames[0]?.id ?? null
  return { message: `${frames.length} slide${frames.length === 1 ? '' : 's'} imported.` }
}

async function loadDesignCommand(
  store: EditorStore,
  command: CommandArgs
): Promise<{ message: string }> {
  resetPreview(store)
  const source = command.fig
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source)
    await openFileInNewTab(
      new File(
        [exactArrayBuffer(bytes)],
        commandString(command.fileName, 'OpenPencil template.fig')
      )
    )
    templateFrameId = null
  } else {
    const frame = loadLegacyTemplate(store, command.design, command.layers, addFrame)
    templateFrameId = frame.id
  }
  return { message: 'Template loaded.' }
}

const commandHandlers: Partial<Record<string, CommandHandler>> = {
  'add-frame': async (store) => addFrameCommand(store),
  'mark-image': async (store) => markSlot(store, 'image'),
  'mark-text': async (store) => markSlot(store, 'text'),
  'safe-zone': async (store) => toggleSafeZone(store),
  preview: async (store, command) => previewScript(store, command),
  'reset-preview': async (store) => {
    resetPreview(store)
    return { message: 'Preview reset.' }
  },
  'import-slides': importSlidesCommand,
  'load-design': loadDesignCommand,
  'export-template': exportTemplate
}

async function onMessage(event: MessageEvent, getStore: () => EditorStore): Promise<void> {
  if (event.origin !== window.location.origin || event.source !== window.parent) return
  const message = event.data as unknown
  if (!isRecord(message) || message.source !== 'postroom' || message.type !== 'command') return
  const id = Number(message.id)
  if (!Number.isSafeInteger(id) || !isRecord(message.command)) return
  const command = message.command
  if (typeof command.op !== 'string') return
  const handler = commandHandlers[command.op]
  try {
    if (!handler) throw new Error('Unsupported Studio action.')
    reply(id, { ok: true, result: await handler(getStore(), command) })
  } catch (error) {
    reply(id, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function installPostroomBridge(getStore: () => EditorStore): () => void {
  const handler = (event: MessageEvent) => void onMessage(event, getStore)
  window.addEventListener('message', handler)
  window.parent.postMessage({ source: 'openpencil', type: 'ready' }, window.location.origin)
  return () => window.removeEventListener('message', handler)
}
