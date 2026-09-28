import { FigmaAPI } from '@open-pencil/core/figma-api'
import type { SceneNode } from '@open-pencil/scene-graph'
import { BLACK } from '@open-pencil/scene-graph/constants'
import type { Rect } from '@open-pencil/scene-graph/primitives'

import type { EditorStore } from '@/app/editor/session'

export interface StudioSlide {
  name: string
  imageUrl: string
  text: string
  width: number
  height: number
  textBox: Rect
  style?: 'bold-bottom' | 'center-card' | 'minimal-top'
}

export async function importStudioSlides(
  store: EditorStore,
  slides: StudioSlide[]
): Promise<SceneNode[]> {
  if (!Array.isArray(slides) || !slides.length) throw new Error('There are no slides to import.')
  if (slides.length > 30) throw new Error('Import up to 30 slides at a time.')

  const graph = store.graph
  const imageAPI = new FigmaAPI(graph)
  const frames: SceneNode[] = []
  for (const [index, slide] of slides.entries()) {
    const width = Math.max(1, Math.round(slide.width))
    const height = Math.max(1, Math.round(slide.height))
    const frame = graph.createNode('FRAME', store.state.currentPageId, {
      name: slide.name || `Slide ${index + 1}`,
      width,
      height,
      clipsContent: true,
      fills: [],
      x: index * (width + 80),
      y: 0
    })
    frames.push(frame)

    const response = await fetch(slide.imageUrl)
    if (!response.ok) throw new Error(`Could not load ${slide.name || `slide ${index + 1}`} image.`)
    const imageHash = imageAPI.createImage(new Uint8Array(await response.arrayBuffer())).hash
    graph.createNode('RECTANGLE', frame.id, {
      name: 'IMAGE_SLOT',
      x: 0,
      y: 0,
      width,
      height,
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

    const { x, y, width: textWidth, height: textHeight } = slide.textBox
    if (slide.style === 'minimal-top') {
      graph.createNode('RECTANGLE', frame.id, {
        name: 'Caption backdrop',
        x: 0,
        y: 0,
        width,
        height: Math.round(height * 0.39),
        fills: [{ type: 'SOLID', color: BLACK, opacity: 0.55, visible: true }]
      })
    } else {
      const margin = Math.round(width * 0.07)
      const boxHeight = Math.round(height * 0.38)
      const top =
        slide.style === 'center-card'
          ? Math.round((height - boxHeight) / 2)
          : height - boxHeight - Math.round(height * 0.1)
      graph.createNode('RECTANGLE', frame.id, {
        name: 'Caption backdrop',
        x: margin,
        y: top,
        width: width - margin * 2,
        height: boxHeight,
        cornerRadius: slide.style === 'center-card' ? Math.round(width * 0.045) : 0,
        fills: [
          {
            type: 'SOLID',
            color: BLACK,
            opacity: slide.style === 'center-card' ? 0.78 : 0.62,
            visible: true
          }
        ]
      })
    }
    graph.createNode('TEXT', frame.id, {
      name: 'SCRIPT_TEXT',
      x,
      y,
      width: textWidth,
      height: textHeight,
      text: slide.text,
      fontSize: Math.max(20, Math.round(width * (slide.style === 'minimal-top' ? 0.048 : 0.062))),
      fontFamily: 'Inter',
      fontWeight: 700,
      textAlignHorizontal: slide.style === 'minimal-top' ? 'LEFT' : 'CENTER',
      textAlignVertical: 'CENTER',
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }]
    })
  }
  store.state.selectedIds.clear()
  if (frames[0]) store.state.selectedIds.add(frames[0].id)
  return frames
}
