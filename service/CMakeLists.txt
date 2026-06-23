# SV Publisher — headless WebSocket configuration service
#
# Build:  cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
# Run:    ./build/sv_publisher_service [port]      (default 9001)
#
# Links the same native engine the Tauri app uses (../native) plus a vendored
# uWebSockets/uSockets. Config-only — no high-speed data path.

cmake_minimum_required(VERSION 3.16)
project(sv_publisher_service VERSION 1.0.0 LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(ROOT      ${CMAKE_CURRENT_SOURCE_DIR}/..)
set(NATIVE    ${ROOT}/native)
set(UWS       ${CMAKE_CURRENT_SOURCE_DIR}/third_party/uWebSockets)
set(USOCKETS  ${UWS}/uSockets)
set(THIRD     ${CMAKE_CURRENT_SOURCE_DIR}/third_party)

# ── Dependencies ─────────────────────────────────────────────────────────
find_library(PCAP_LIB pcap REQUIRED)
find_package(ZLIB REQUIRED)

# ── uSockets (C) — Linux/epoll, no TLS ───────────────────────────────────
add_library(usockets STATIC
    ${USOCKETS}/src/bsd.c
    ${USOCKETS}/src/context.c
    ${USOCKETS}/src/socket.c
    ${USOCKETS}/src/loop.c
    ${USOCKETS}/src/udp.c
    ${USOCKETS}/src/eventing/epoll_kqueue.c
)
target_include_directories(usockets PRIVATE ${USOCKETS}/src)
target_compile_definitions(usockets PRIVATE LIBUS_NO_SSL LIBUS_USE_EPOLL)

# ── Native SV publisher engine (same sources as the Tauri build) ─────────
add_library(sv_engine STATIC
    ${NATIVE}/src/sv_native_refactored.cc
    ${NATIVE}/src/npcap_transmitter_impl.cc
    ${NATIVE}/src/sv_encoder_impl.cc
    ${NATIVE}/src/sv_stats_impl.cc
    ${NATIVE}/src/equation_processor.cc
    ${NATIVE}/src/sv_publisher_instance.cc
    ${NATIVE}/src/sv_controller.cc
    ${NATIVE}/src/cid_generator.cc
    ${NATIVE}/src/fault_injector.cc
)
target_include_directories(sv_engine PUBLIC ${NATIVE}/include ${NATIVE}/src)
target_compile_options(sv_engine PRIVATE -O2 -fPIC)
target_link_libraries(sv_engine PUBLIC ${PCAP_LIB} pthread)

# ── Service executable ───────────────────────────────────────────────────
add_executable(sv_publisher_service
    ${CMAKE_CURRENT_SOURCE_DIR}/main.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/ws_server.cc
)
target_include_directories(sv_publisher_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${NATIVE}/include
    ${UWS}/src
    ${USOCKETS}/src
    ${THIRD}
)
target_compile_definitions(sv_publisher_service PRIVATE LIBUS_NO_SSL LIBUS_USE_EPOLL)
target_compile_options(sv_publisher_service PRIVATE -O2)
target_link_libraries(sv_publisher_service PRIVATE sv_engine usockets ZLIB::ZLIB pthread)
