Place Emscripten build artifacts here:

  tec_engine.js
  tec_engine.wasm

Build from the repository root (with Emscripten active):

  emcmake cmake -B wasm/build -S wasm -DCMAKE_BUILD_TYPE=Release
  cmake --build wasm/build

The CMakeLists copies outputs into this folder automatically.
