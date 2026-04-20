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

float mistOrb(vec2 p, vec2 center, vec2 stretch, float blur) {
  vec2 q = (p - center) / stretch;
  float dist = dot(q, q);
  return exp(-dist * blur);
}

float rippleField(vec2 p, float t) {
  float wave = sin(p.x * 1.8 + t * 0.8);
  wave += sin(p.y * 2.3 - t * 0.6);
  wave += sin((p.x + p.y) * 1.35 + t * 0.45);
  return wave / 3.0;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_resolution.x / u_resolution.y;

  float t = u_time * 0.085;

  vec3 sumiInk = vec3(0.03, 0.038, 0.075);
  vec3 sakuraMist = vec3(0.97, 0.78, 0.82);
  vec3 seijiMint = vec3(0.72, 0.88, 0.82);
  vec3 aizome = vec3(0.35, 0.5, 0.82);
  vec3 shojiGlow = vec3(0.98, 0.96, 0.91);

  vec2 flow = vec2(rippleField(p * 0.9, t), rippleField(p.yx * 1.1, t + 1.3));
  vec2 drifted = p + flow * 0.08;

  float orbA = mistOrb(drifted, vec2(-0.58 + sin(t * 0.7) * 0.12, -0.22 + cos(t * 0.9) * 0.08), vec2(0.72, 0.86), 2.2);
  float orbB = mistOrb(drifted, vec2(0.48 + cos(t * 0.55) * 0.14, -0.36 + sin(t * 0.7) * 0.12), vec2(0.8, 0.72), 2.0);
  float orbC = mistOrb(drifted, vec2(-0.08 + sin(t * 0.4) * 0.1, 0.52 + cos(t * 0.6) * 0.08), vec2(1.05, 0.65), 2.4);
  float orbD = mistOrb(drifted, vec2(0.0, 0.06 + sin(t * 0.5) * 0.06), vec2(1.35, 1.0), 3.4);

  float horizon = smoothstep(-1.0, 0.55, p.y);
  float glowBand = exp(-pow((p.y + 0.08 + flow.x * 0.12) * 2.4, 2.0));
  float grain = (hash(gl_FragCoord.xy * 0.42 + t * 17.0) - 0.5) * 0.016;
  float vignette = 1.0 - dot(uv - 0.5, uv - 0.5) * 0.72;

  vec3 base = mix(sumiInk, aizome, horizon * 0.48);

  vec3 glow = sakuraMist * orbA * 0.34;
  glow += seijiMint * orbB * 0.3;
  glow += aizome * orbC * 0.26;
  glow += shojiGlow * orbD * 0.18;
  glow += shojiGlow * glowBand * 0.08;

  vec3 result = base + glow;
  result *= 0.94 + vignette * 0.18;
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

    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);

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
