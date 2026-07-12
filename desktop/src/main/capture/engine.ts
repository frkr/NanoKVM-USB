// Uncompressed (YUY2/yuvs) capture — macOS Phase 1. Spawns the bundled
// nanokvm-capture Swift helper (native AVFoundation; ffmpeg's avfoundation
// input freezes on >=1080p uncompressed frames), assembles exact-size raw
// frames (O(n) fill buffer — a naive Buffer.concat is O(n^2) and throttles the
// pipeline), and pushes each frame to the renderer over a MessagePortMain.
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import type { MessagePortMain } from 'electron'

export type CaptureDevice = { index: number; name: string }
export type CaptureOptions = {
  deviceIndex?: number
  width: number
  height: number
  fps: number
  requestId?: number
}
export type Mode = { width: number; height: number; fps: number[] }
// device is the AVFoundation device NAME: indices are not stable — Continuity
// cameras (iPhone/Desk View) insert and remove themselves and shift the list.
export type ResolvedCapture = { device: string; width: number; height: number; fps: number }

const HELPER_CANDIDATES = [
  process.env.NANOKVM_CAPTURE_PATH,
  join(__dirname, '../../resources/nanokvm-capture')
].filter(Boolean) as string[]

function helperPath(): string {
  const p = HELPER_CANDIDATES.find((c) => existsSync(c))
  if (!p) throw new Error('nanokvm-capture helper not found (build it with pnpm build:capture)')
  return p
}

const nowAbs = (): number => performance.timeOrigin + performance.now()

type HelperFormat = { pixfmt: string; width: number; height: number; fps: number[] }
type HelperDevice = { name: string; formats: HelperFormat[] }

function listAll(): Promise<HelperDevice[]> {
  return new Promise((resolve) => {
    execFile(helperPath(), ['list'], (_err, stdout) => {
      try {
        resolve(JSON.parse(stdout).devices as HelperDevice[])
      } catch {
        resolve([])
      }
    })
  })
}

/** Enumerate video capture devices. */
export async function listDevices(): Promise<CaptureDevice[]> {
  return (await listAll()).map((d, index) => ({ index, name: d.name }))
}

/** Pick the most likely capture device when the caller doesn't specify one. */
function autoPick(devices: HelperDevice[]): string {
  const pref = devices.find(
    (d) =>
      /usb|video|capture|hdmi|kvm/i.test(d.name) &&
      !/facetime|desk view|iphone|capture screen/i.test(d.name)
  )
  return (pref || devices[0])?.name ?? ''
}

/**
 * Resolve a requested capture to a device + a mode the device advertises.
 * If the requested resolution isn't offered, fall back to the largest one.
 * Note the UVC stack may still serve the signal-native mode regardless — the
 * helper reports the ACTUAL dimensions when the stream starts.
 */
export async function resolveCapture(opts: CaptureOptions): Promise<ResolvedCapture> {
  const devices = await listAll()
  const byIndex = opts.deviceIndex !== undefined ? devices[opts.deviceIndex] : undefined
  const device = byIndex ? byIndex.name : autoPick(devices)
  if (!device) throw new Error('no capture device found')

  const modes = new Map<string, Mode>()
  for (const f of devices.find((d) => d.name === device)?.formats ?? []) {
    if (f.pixfmt !== 'yuvs') continue
    const key = `${f.width}x${f.height}`
    const mode = modes.get(key) || { width: f.width, height: f.height, fps: [] }
    for (const v of f.fps) if (v && !mode.fps.includes(v)) mode.fps.push(v)
    modes.set(key, mode)
  }

  let { width, height } = opts
  let mode = modes.get(`${width}x${height}`)
  if (!mode && modes.size) {
    mode = [...modes.values()].reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    width = mode.width
    height = mode.height
  }

  // Highest advertised fps <= requested (small tolerance), else the lowest.
  let fps = opts.fps
  if (mode && mode.fps.length) {
    const candidates = [...mode.fps].sort((a, b) => a - b)
    const atMost = candidates.filter((f) => f <= opts.fps + 0.5)
    fps = atMost.length ? atMost[atMost.length - 1] : candidates[0]
  }

  return { device, width, height, fps }
}

export class CaptureSession {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stopping = false

  /**
   * Spawn the helper and resolve with the ACTUAL frame dimensions (from its
   * META line) once the first frame is captured. Frames then flow to `port`.
   */
  start(
    port: MessagePortMain,
    opts: ResolvedCapture,
    onError: (msg: string) => void
  ): Promise<{ width: number; height: number }> {
    this.stopping = false

    const args = [
      'stream',
      '--device',
      opts.device,
      '--width',
      String(opts.width),
      '--height',
      String(opts.height),
      '--fps',
      String(opts.fps)
    ]
    console.log('[capture] spawn helper', args.join(' '))
    const proc = spawn(helperPath(), args)
    this.proc = proc

    return new Promise((resolve, reject) => {
      let stderr = ''
      let seq = 0
      let started = false

      const startupTimeout = setTimeout(() => {
        if (!started) {
          this.stop()
          reject(new Error('capture start timed out'))
        }
      }, 10000)

      const attachPump = (width: number, height: number): void => {
        const frameBytes = width * height * 2 // yuvs
        const frameBuf = Buffer.allocUnsafe(frameBytes)
        let filled = 0

        // Ack-based backpressure: only one frame in flight; while the renderer
        // is busy the freshest frame waits in pendingBuf (older ones drop).
        // Flooding the port faster than the renderer draws backs up the message
        // queue and starves its event loop (input goes dead).
        let rendererReady = true
        let hasPending = false
        const pendingBuf = Buffer.allocUnsafe(frameBytes)

        const post = (buf: Buffer): void => {
          const ab = new ArrayBuffer(frameBytes)
          new Uint8Array(ab).set(buf)
          rendererReady = false
          try {
            port.postMessage({ seq: seq++, emitAbs: nowAbs(), width, height, buf: ab })
          } catch {
            this.stop()
          }
        }

        port.on('message', () => {
          if (hasPending) {
            hasPending = false
            post(pendingBuf)
          } else {
            rendererReady = true
          }
        })

        proc.stdout.on('data', (chunk: Buffer) => {
          let off = 0
          while (off < chunk.length) {
            const take = Math.min(frameBytes - filled, chunk.length - off)
            chunk.copy(frameBuf, filled, off, off + take)
            filled += take
            off += take
            if (filled < frameBytes) break

            filled = 0
            if (rendererReady) {
              post(frameBuf)
            } else {
              frameBuf.copy(pendingBuf)
              hasPending = true
            }
          }
        })
      }

      proc.stderr.on('data', (d: Buffer) => {
        const text = d.toString()
        const meta = text.match(/^META\s+(\{.*\})/m)
        if (meta && !started) {
          started = true
          clearTimeout(startupTimeout)
          try {
            const { width, height } = JSON.parse(meta[1])
            console.log('[capture] actual mode', width, 'x', height)
            attachPump(width, height)
            resolve({ width, height })
          } catch (e) {
            this.stop()
            reject(e)
          }
          return
        }
        stderr += text
        console.error('[capture][helper]', text.trim())
      })

      proc.on('close', (code) => {
        console.log('[capture] helper closed code=', code, 'frames=', seq)
        const wasCurrent = this.proc === proc
        if (wasCurrent) this.proc = null
        clearTimeout(startupTimeout)
        // Any unexpected end (device unplugged, signal loss) => notify the
        // renderer so it doesn't keep showing a frozen frame.
        if (wasCurrent && !this.stopping) {
          const msg = stderr.trim() || 'capture ended (device disconnected?)'
          if (started) onError(msg)
          else reject(new Error(msg))
        }
      })
      proc.on('error', (e) => {
        clearTimeout(startupTimeout)
        if (started) onError(e.message)
        else reject(e)
      })
    })
  }

  stop(): void {
    this.stopping = true
    if (this.proc) {
      const proc = this.proc
      this.proc = null
      // SIGINT lets the helper tear down the AVFoundation session cleanly —
      // hard kills can wedge the capture device / camera daemon.
      try {
        proc.kill('SIGINT')
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 1500)
    }
  }

  get running(): boolean {
    return this.proc !== null
  }
}
