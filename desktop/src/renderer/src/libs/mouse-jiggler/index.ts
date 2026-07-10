import { IpcEvents } from '@common/ipc-events'
import { MouseReportRelative } from '@renderer/libs/mouse'

const MOUSE_JIGGLER_INTERVAL = 15_000

class MouseJiggler {
  private lastMoveTime: number
  private timer: NodeJS.Timeout | null
  private mode: 'enable' | 'disable'
  private mouseReport: MouseReportRelative

  // Figure-8 (lemniscate) pattern state
  private figure8Step: number = 0
  private readonly FIGURE8_STEPS = 24
  private readonly BASE_AMPLITUDE = 35
  private readonly STEPS_PER_JIGGLE = 5

  constructor() {
    this.lastMoveTime = Date.now()
    this.timer = null
    this.mode = 'disable'
    this.mouseReport = new MouseReportRelative()
  }

  // enable or disable mouse jiggler
  setMode(mode: 'enable' | 'disable'): void {
    this.mode = mode
    if (mode === 'disable' && this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    } else if (mode === 'enable' && this.timer === null) {
      this.timer = setInterval(() => {
        this.timeoutCallback()
      }, MOUSE_JIGGLER_INTERVAL / 5)
    }
  }

  // addEventListener to canvas on 'mousemove' event
  moveEventCallback(): void {
    if (this.mode === 'enable') {
      this.lastMoveTime = Date.now()
    }
  }

  timeoutCallback(): void {
    if (Date.now() - this.lastMoveTime > MOUSE_JIGGLER_INTERVAL) {
      this.lastMoveTime = Date.now() - 1_000
      this.sendJiggle()
    }
  }

  /**
   * Send a figure-8 (lemniscate) mouse movement pattern.
   * Uses parametric equations: x = A * sin(t), y = A * sin(2t) / 2
   * Each call advances STEPS_PER_JIGGLE steps along the curve.
   * Amplitude varies randomly for natural-looking movement.
   */
  async sendJiggle(): Promise<void> {
    const amp = this.BASE_AMPLITUDE + (Math.random() - 0.5) * 12

    for (let i = 0; i < this.STEPS_PER_JIGGLE; i++) {
      const t = (this.figure8Step / this.FIGURE8_STEPS) * 2 * Math.PI
      const tNext = ((this.figure8Step + 1) / this.FIGURE8_STEPS) * 2 * Math.PI

      // Lemniscate parametric: x = A*sin(t), y = A*sin(2t)/2
      const x = amp * Math.sin(t)
      const y = (amp * Math.sin(2 * t)) / 2
      const xNext = amp * Math.sin(tNext)
      const yNext = (amp * Math.sin(2 * tNext)) / 2

      const dx = Math.round(xNext - x)
      const dy = Math.round(yNext - y)

      const report = this.mouseReport.buildReport(dx, dy, 0)
      await window.electron.ipcRenderer.invoke(IpcEvents.SEND_MOUSE, [0x01, ...report])

      this.figure8Step = (this.figure8Step + 1) % this.FIGURE8_STEPS
    }
  }
}

export const mouseJiggler = new MouseJiggler()
