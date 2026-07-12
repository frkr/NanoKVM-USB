// WebGL2 renderer: uploads a yuvs (YUY2) frame to an integer texture and
// converts it to RGB in a fragment shader. Used by the uncompressed capture
// path, which delivers raw frames that a plain <video> can't display.
//
// Two-pass for display quality: pass 1 converts YUY2→RGB at source size into a
// framebuffer texture; pass 2 blits it with LINEAR filtering to a canvas buffer
// at 2x source size. The browser then bilinearly *downscales* to the displayed
// size, which stays sharp — a direct nearest/bilinear upscale of the source
// buffer looks jagged/soft at non-integer HiDPI scale factors.

const SUPERSAMPLE = 2

const VERT = `#version 300 es
void main(){ vec2 v[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.)); gl_Position=vec4(v[gl_VertexID],0.,1.); }`

const FRAG = `#version 300 es
precision highp float; precision highp int;
uniform highp usampler2D tex; uniform int uH;
out vec4 frag;
void main(){
  int x=int(gl_FragCoord.x); int y=uH-1-int(gl_FragCoord.y); int mp=x>>1;
  uvec4 t=texelFetch(tex, ivec2(mp,y), 0);        // yuvs: Y0 U Y1 V
  float U=float(t.g), V=float(t.a);
  float Y=((x&1)==0)?float(t.r):float(t.b);
  float yy=Y-16.0, uu=U-128.0, vv=V-128.0;
  float r=1.164*yy+1.596*vv, g=1.164*yy-0.392*uu-0.813*vv, b=1.164*yy+2.017*uu;
  frag=vec4(clamp(vec3(r,g,b)/255.0,0.0,1.0),1.0);
}`

export class YuvRenderer {
  private gl: WebGL2RenderingContext | null = null
  private tex: WebGLTexture | null = null
  private rgbTex: WebGLTexture | null = null
  private fbo: WebGLFramebuffer | null = null
  private width = 0
  private height = 0

  init(canvas: HTMLCanvasElement, width: number, height: number): boolean {
    this.width = width
    this.height = height
    canvas.width = width * SUPERSAMPLE
    canvas.height = height * SUPERSAMPLE

    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false })
    if (!gl) return false
    this.gl = gl

    const prog = this.link(gl, VERT, FRAG)
    if (!prog) return false
    gl.useProgram(prog)
    gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0)
    gl.uniform1i(gl.getUniformLocation(prog, 'uH'), height)

    // Source YUY2 texture (integer, exact texel reads in the shader).
    // Immutable storage — per-frame uploads use texSubImage2D (no realloc).
    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, width / 2, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    // Intermediate RGB target at source size for the pass-2 linear blit.
    this.rgbTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.rgbTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    this.fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.rgbTex, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('capture framebuffer incomplete')
      return false
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return true
  }

  render(frame: Uint8Array): void {
    const gl = this.gl
    if (!gl) return

    // Pass 1: YUY2 -> RGB at source size, into the FBO.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.width, this.height)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.width / 2,
      this.height,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_BYTE,
      frame
    )
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Pass 2: linear blit up to the supersampled backbuffer.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.blitFramebuffer(
      0,
      0,
      this.width,
      this.height,
      0,
      0,
      this.width * SUPERSAMPLE,
      this.height * SUPERSAMPLE,
      gl.COLOR_BUFFER_BIT,
      gl.LINEAR
    )
  }

  // TEMP (debug): read back one pixel from the drawn backbuffer to prove the
  // displayed content is actually updating. Must be called right after render()
  // within the same rAF callback (preserveDrawingBuffer is false).
  probe(): string {
    const gl = this.gl
    if (!gl) return 'no-gl'
    if (gl.isContextLost()) return 'CONTEXT-LOST'
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null) // read the displayed backbuffer
    const px = new Uint8Array(4)
    const cx = Math.floor((this.width * SUPERSAMPLE) / 2)
    const cy = Math.floor((this.height * SUPERSAMPLE) / 2)
    gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const err = gl.getError()
    return `px=${px.join(',')}${err ? ` glErr=${err}` : ''}`
  }

  dispose(): void {
    const gl = this.gl
    if (gl) {
      if (this.tex) gl.deleteTexture(this.tex)
      if (this.rgbTex) gl.deleteTexture(this.rgbTex)
      if (this.fbo) gl.deleteFramebuffer(this.fbo)
    }
    this.gl = null
    this.tex = null
    this.rgbTex = null
    this.fbo = null
  }

  private link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('shader compile error:', gl.getShaderInfoLog(sh))
        return null
      }
      return sh
    }
    const v = compile(gl.VERTEX_SHADER, vs)
    const f = compile(gl.FRAGMENT_SHADER, fs)
    if (!v || !f) return null
    const prog = gl.createProgram()
    if (!prog) return null
    gl.attachShader(prog, v)
    gl.attachShader(prog, f)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('program link error:', gl.getProgramInfoLog(prog))
      return null
    }
    return prog
  }
}
