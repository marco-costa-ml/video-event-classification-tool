cmake_minimum_required(VERSION 3.16)
project(tec_engine LANGUAGES CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with Emscripten: emcmake cmake -B build -S .")
endif()

set(CMAKE_CXX_STANDARD 17)

include(FetchContent)
FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
)
FetchContent_MakeAvailable(nlohmann_json)

add_executable(tec_engine bindings.cpp)
target_link_libraries(tec_engine PRIVATE nlohmann_json::nlohmann_json)

set(OUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../public/wasm")
file(MAKE_DIRECTORY "${OUT_DIR}")

set_target_properties(tec_engine PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${OUT_DIR}"
  OUTPUT_NAME "tec_engine"
)

target_link_options(tec_engine PRIVATE
  "SHELL:-lembind"
  "SHELL:-sMODULARIZE=1"
  "SHELL:-sEXPORT_ES6=1"
  "SHELL:-sENVIRONMENT=web"
  "SHELL:-sALLOW_MEMORY_GROWTH=1"
  "SHELL:-O2"
)
