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

float waveBand(vec2 p, float t, float offset, float amplitude, float frequency, float width) {
  float wave = sin(p.x * frequency + t * 1.35 + offset * 6.0) * amplitude;
  wave += sin(p.x * (frequency * 0.58) - t * 0.72 + offset * 9.0) * amplitude * 0.52;
  wave += cos(p.x * (frequency * 0.25) + t * 0.24) * amplitude * 0.28;
  float band = abs(p.y + wave - offset);
  return smoothstep(width, 0.0, band);
}

float foamField(vec2 p, float t) {
  float low = waveBand(p + vec2(0.08 * sin(t * 0.18), 0.0), t, -0.54, 0.13, 2.4, 0.34);
  float mid = waveBand(p, t, -0.16, 0.09, 4.1, 0.24);
  float crest = waveBand(p + vec2(0.03 * cos(t * 0.37), 0.0), t, 0.28, 0.05, 6.8, 0.12);
  return low * 0.38 + mid * 0.72 + crest * 0.96;
}

float kintsugiSeam(vec2 p, float t, float bend, float offset, float width) {
  float seam = p.y + p.x * bend;
  seam += sin(p.x * (5.0 + bend * 4.0) + t * 0.42 + offset * 12.0) * 0.052;
  seam += sin(p.x * 12.5 - t * 0.21 + offset * 18.0) * 0.018;
  return smoothstep(width, 0.0, abs(seam - offset));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;

  float t = u_time * 0.095;

  vec3 aiBase = vec3(0.018, 0.03, 0.07);
  vec3 deepWater = vec3(0.03, 0.14, 0.2);
  vec3 seijiFoam = vec3(0.54, 0.76, 0.74);
  vec3 kinGold = vec3(0.89, 0.72, 0.34);
  vec3 warmShell = vec3(0.97, 0.91, 0.8);
  vec3 urushiNight = vec3(0.014, 0.015, 0.03);

  float depthLift = smoothstep(-1.0, 0.85, p.y);
  vec3 base = mix(aiBase, deepWater, depthLift * 0.82);

  float foam = foamField(p, t);
  float trailingWave = waveBand(p + vec2(0.0, 0.04 * sin(t * 0.3)), t, 0.46, 0.035, 8.4, 0.085);
  float tideShadow = waveBand(p, t, -0.7, 0.14, 2.1, 0.5);

  float mistLine = exp(-pow((p.y + 0.58 + 0.05 * sin(t * 0.26 + p.x * 1.8)) * 3.2, 2.0));
  float trench = 1.0 - smoothstep(-0.95, -0.12, p.y);
  float vignette = 1.0 - dot(uv - 0.5, uv - 0.5) * 0.92;
  float grain = (hash(gl_FragCoord.xy * 0.48 + t * 23.0) - 0.5) * 0.028;

  base += seijiFoam * mistLine * 0.18;
  base = mix(base, urushiNight, tideShadow * 0.2 + trench * 0.24);

  float seamPrimary = kintsugiSeam(p, t, 0.18, -0.12, 0.024);
  float seamBranch = kintsugiSeam(p + vec2(0.14, -0.08), t, -0.22, 0.18, 0.014);
  float seamAccent = kintsugiSeam(p + vec2(-0.12, 0.18), t, 0.08, 0.46, 0.016);
  float seam = seamPrimary * 0.88 + seamBranch * 0.54 + seamAccent * 0.36;
  float seamPulse = 0.72 + 0.28 * sin(p.x * 5.0 - t * 1.4);

  vec3 foamGlow = seijiFoam * (foam * 0.34 + trailingWave * 0.22);
  foamGlow += warmShell * pow(trailingWave, 2.0) * 0.08;

  vec3 seamGlow = kinGold * seam * (0.82 + seamPulse * 0.34);
  seamGlow += warmShell * pow(seam, 2.3) * 0.24;

  vec3 result = base + foamGlow + seamGlow;
  result *= 0.94 + vignette * 0.2;
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
