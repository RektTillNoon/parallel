import { useEffect, useRef } from 'react';

export const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float currentRibbon(vec2 p, float t, float offset, float slope, float width) {
  vec2 q = p;
  q.x += q.y * slope;
  float wobble = sin(q.y * 7.5 - t * 2.7 + offset * 6.0) * 0.075;
  wobble += sin(q.y * 17.0 + t * 1.85 + offset * 10.0) * 0.03;
  float band = abs(q.x + wobble - offset);
  return smoothstep(width, 0.0, band);
}

float bloomField(vec2 p, float t) {
  float left = currentRibbon(p + vec2(0.0, 0.04 * sin(t * 0.7)), t, -0.32, 0.54, 0.18);
  float center = currentRibbon(p, t, 0.02, 0.12, 0.24);
  float right = currentRibbon(p + vec2(0.0, -0.03 * cos(t * 0.85)), t, 0.34, -0.44, 0.16);
  return left * 0.82 + center * 0.56 + right * 0.74;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;

  float t = u_time * 0.11;

  vec3 sumiBase = vec3(0.025, 0.024, 0.03);
  vec3 emberBase = vec3(0.19, 0.09, 0.055);
  vec3 amberHorizon = vec3(0.95, 0.54, 0.28);
  vec3 goldCurrent = vec3(0.98, 0.79, 0.33);
  vec3 whiteBloom = vec3(0.97, 0.96, 0.92);
  vec3 charcoalBand = vec3(0.03, 0.025, 0.02);

  float horizonLift = smoothstep(-1.0, 0.25, p.y);
  vec3 base = mix(sumiBase, emberBase, horizonLift * 0.58);
  float horizonCore = exp(-pow((p.y + 0.2 + 0.025 * sin(t * 0.45 + p.x * 1.35)) * 4.4, 2.0));
  base += amberHorizon * horizonCore * 0.86;
  base = mix(base, charcoalBand, smoothstep(-0.1, 0.12, p.y) * 0.22);

  float leftCurrent = currentRibbon(p, t, -0.28, 0.56, 0.1);
  float centerCurrent = currentRibbon(p, t, 0.04, 0.18, 0.13);
  float rightCurrent = currentRibbon(p, t, 0.31, -0.46, 0.09);
  float plasma = bloomField(p, t);

  float amberBleed = exp(-pow((p.y + 0.24) * 7.0, 2.0)) * (0.55 + 0.45 * sin(p.x * 2.0 + t * 0.8));
  float scanline = 0.975 + 0.025 * sin(uv.y * u_resolution.y * 0.72 + p.x * 10.0);
  float grain = (hash(gl_FragCoord.xy * 0.65 + t * 19.0) - 0.5) * 0.03;

  vec3 bloom = goldCurrent * (leftCurrent * 0.9 + centerCurrent * 0.52 + plasma * 0.16);
  bloom += whiteBloom * (rightCurrent * 0.76 + plasma * 0.24);
  bloom += amberHorizon * amberBleed * 0.22;

  vec3 result = base + bloom * (0.5 + horizonCore * 0.35);
  result += whiteBloom * pow(plasma, 1.9) * 0.16;
  result *= scanline;
  result += grain;

  gl_FragColor = vec4(result, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function ShaderBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false }) as
      | WebGLRenderingContext
      | null;
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const timeLocation = gl.getUniformLocation(program, 'u_time');

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    function resize() {
      if (!canvas) return;
      const width = canvas.clientWidth * dpr;
      const height = canvas.clientHeight * dpr;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl?.viewport(0, 0, width, height);
      }
    }

    let raf = 0;
    const start = performance.now();

    function render(now: number) {
      resize();
      if (!canvas || !gl) return;
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!reduceMotion) {
        raf = requestAnimationFrame(render);
      }
    }

    if (reduceMotion) {
      render(start);
    } else {
      raf = requestAnimationFrame(render);
    }

    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={canvasRef} className="shader-backdrop" aria-hidden="true" />;
}
