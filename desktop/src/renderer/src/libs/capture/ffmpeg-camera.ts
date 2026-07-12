// Renderer-side controller for the FFmpeg uncompressed-capture path. Mirrors the
// shape of libs/media/camera.ts (open/close/isOpen) but, instead of a MediaStream
// on a <video>, it drives a WebGL <canvas> fed raw uyvy422 frames from the main
// process over a MessagePort.
import { IpcEvents } from '@common/ipc-events'

import { YuvRenderer } from './yuv-renderer'

type OpenOptions = {
  canvas: HTMLCanvasElement
  width: number
  height: number
  fps: number
  deviceIndex?: number
  onError?: (msg: string) => void
}

type FrameMessage = {
  seq: number
  emitAbs: number
  width: number
  height: number
  buf: ArrayBuffer
}

let nextRequestId = 0

class FfmpegCamera {
  private renderer: YuvRenderer | null = null
  private port: MessagePort | null = null
  private canvas: HTMLCanvasElement | null = null
  private onPortMessage: ((e: MessageEvent) => void) | null = null
  private onError?: (msg: string) => void
  private open_ = false
  private latestFrame: Uint8Array | null = null
  private frameDirty = false
  private rafId = 0

  async open(opts: OpenOptions): Promise<void> {
    this.close()
    this.canvas = opts.canvas
    this.onError = opts.onError
    const requestId = ++nextRequestId

    window.electron.ipcRenderer.on(IpcEvents.CAPTURE_ERROR, this.handleError)

    // Receive the transferred MessagePort forwarded by the preload. Match on
    // requestId — a port from a superseded start request must not be attached.
    const portReceived = new Promise<void>((resolve) => {
      this.onPortMessage = (e: MessageEvent): void => {
        if (!e.data || e.data.type !== 'capture-port') return
        if (e.data.meta?.requestId !== requestId) {
          console.log('capture: ignoring stale port', e.data.meta)
          e.ports[0]?.close()
          return
        }
        console.log('capture: port received', e.data.meta, 'ports=', e.ports.length)
        window.removeEventListener('message', this.onPortMessage as EventListener)
        this.onPortMessage = null
        this.attachPort(e.ports[0], e.data.meta.width, e.data.meta.height)
        resolve()
      }
      window.addEventListener('message', this.onPortMessage as EventListener)
    })

    console.log('capture: invoking START_CAPTURE', opts.width, opts.height, 'req', requestId)
    try {
      await window.electron.ipcRenderer.invoke(IpcEvents.START_CAPTURE, {
        deviceIndex: opts.deviceIndex,
        width: opts.width,
        height: opts.height,
        fps: opts.fps,
        requestId
      })
    } catch (err) {
      this.close()
      throw err
    }
    await portReceived

    this.open_ = true
  }

  private attachPort(port: MessagePort, width: number, height: number): void {
    console.log('capture: attachPort canvas=', !!this.canvas, width, height)
    if (!this.canvas) {
      this.handleError('capture canvas not found')
      return
    }
    this.renderer = new YuvRenderer()
    if (!this.renderer.init(this.canvas, width, height)) {
      this.handleError('WebGL2 unavailable')
      return
    }
    this.port = port
    let recv = 0
    port.onmessage = (e: MessageEvent<FrameMessage>): void => {
      this.latestFrame = new Uint8Array(e.data.buf)
      this.frameDirty = true
      if (++recv % 60 === 0) console.log('capture-debug renderer received', recv)
    }
    port.start()

    // Render in sync with the compositor. Drawing on message arrival (outside
    // requestAnimationFrame) with preserveDrawingBuffer:false shows a black
    // canvas — the buffer is cleared before it's composited. Only draw when a
    // new frame arrived, and ack it afterwards so main sends the next one —
    // this paces delivery to what we can actually render (see backpressure
    // note in main/capture/ffmpeg.ts).
    let rendered = 0
    const loop = (): void => {
      if (this.frameDirty && this.latestFrame && this.renderer && this.port) {
        this.renderer.render(this.latestFrame)
        this.frameDirty = false
        this.port.postMessage(1)
        if (++rendered % 60 === 0) {
          // TEMP (debug): checksum of the incoming frame + readback of the drawn
          // pixel — proves whether source content and displayed content are live.
          let sum = 0
          for (let i = 0; i < 4096; i++) sum = (sum + this.latestFrame[i * 500]) | 0
          console.log(
            'capture-debug rendered',
            rendered,
            'frameSum=',
            sum,
            this.renderer.probe()
          )
        }
      }
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)

    setTimeout(() => {
      const c = this.canvas
      if (c)
        console.log(
          'capture: canvas buffer',
          c.width,
          c.height,
          'display',
          c.clientWidth,
          c.clientHeight,
          'dpr',
          window.devicePixelRatio
        )
    }, 800)
  }

  close(): void {
    window.electron.ipcRenderer.invoke(IpcEvents.STOP_CAPTURE)
    window.electron.ipcRenderer.removeAllListeners(IpcEvents.CAPTURE_ERROR)
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    this.latestFrame = null
    this.frameDirty = false
    if (this.onPortMessage) {
      window.removeEventListener('message', this.onPortMessage as EventListener)
      this.onPortMessage = null
    }
    if (this.port) {
      this.port.onmessage = null
      this.port.close()
      this.port = null
    }
    if (this.renderer) {
      this.renderer.dispose()
      this.renderer = null
    }
    this.canvas = null
    this.open_ = false
  }

  isOpen(): boolean {
    return this.open_
  }

  private handleError = (...args: unknown[]): void => {
    const text = args.find((a) => typeof a === 'string') as string | undefined
    this.onError?.(text || 'capture error')
  }
}

export const ffmpegCamera = new FfmpegCamera()
