// atmosphere.vert — Fullscreen quad vertex shader (GLSL 100 / WebGL 1 compatible)

attribute vec2 aPosition;
varying vec2 vUV;

void main() {
  vUV = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
