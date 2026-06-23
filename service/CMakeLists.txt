# SV Publisher — headless WebSocket configuration service
#
# Standalone, windowless backend: the same native engine the Tauri app embeds,
# exposed over a WebSocket so a remote frontend can configure/start/stop it.
# This is the separate "run the backend on its own" workflow (the Linux/Yocto
# `sv_publisher_service`), now buildable on Windows too.
#
# Build (Windows, from service/):
#   cmake -B build -G "Visual Studio 17 2022" -A x64
#   cmake --build build --config Release
# Run:
#   .\build\Release\sv_publisher_service.exe [port]     (default 9001)
#
# Build (Linux, from service/):
#   cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
#   ./build/sv_publisher_service [port]
#
# Prerequisites mirror the Tauri build — see ../WINDOWS_BUILD.md:
#   * libuv      (Windows event loop for uSockets) via vcpkg x64-windows-static-md
#   * Npcap SDK  (GooseReceiver links the pcap API) extracted to C:\npcap-sdk
#   * Npcap runtime + (raw send) the usual driver-access rules.

cmake_minimum_required(VERSION 3.16)
project(sv_publisher_service VERSION 1.0.0 LANGUAGES CXX C)

# C++20: PubWsServer/ws_server use designated initializers for the uWS behavior
# struct, which MSVC only accepts at C++20 (GCC/Clang allow them in C++17).
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(ROOT      ${CMAKE_CURRENT_SOURCE_DIR}/..)
set(NATIVE    ${ROOT}/native)
set(UWS       ${CMAKE_CURRENT_SOURCE_DIR}/third_party/uWebSockets)
set(USOCKETS  ${UWS}/uSockets)
set(THIRD     ${CMAKE_CURRENT_SOURCE_DIR}/third_party)

# ── Native SV publisher engine ───────────────────────────────────────────────
# The current engine sources (the same set the Tauri build.rs compiles), MINUS
# PubWsServer.cc — the service ships its own ws_server.cc WebSocket front end.
set(ENGINE_SOURCES
    ${NATIVE}/src/PcapTx.cc
    ${NATIVE}/src/SvEncoder.cc
    ${NATIVE}/src/SvStats.cc
    ${NATIVE}/src/equation_processor.cc
    ${NATIVE}/src/sv_publisher_instance.cc
    ${NATIVE}/src/PublisherController.cc
    ${NATIVE}/src/SharedBuffer.cc
    ${NATIVE}/src/cid_generator.cc
    ${NATIVE}/src/fault_injector.cc
    ${NATIVE}/src/SpscBridge.cc
    ${NATIVE}/src/asn1_ber_encoder.cc
    ${NATIVE}/src/GooseEncoder.cc
    ${NATIVE}/src/GooseTxScheduler.cc
    ${NATIVE}/src/GooseReceiver.cc
    ${NATIVE}/src/GooseService.cc
)

add_library(sv_engine STATIC ${ENGINE_SOURCES})
target_include_directories(sv_engine PUBLIC ${NATIVE}/include ${NATIVE}/src)

add_library(usockets STATIC
    ${USOCKETS}/src/bsd.c
    ${USOCKETS}/src/context.c
    ${USOCKETS}/src/socket.c
    ${USOCKETS}/src/loop.c
    ${USOCKETS}/src/udp.c
)
target_include_directories(usockets PRIVATE ${USOCKETS}/src)

# The service reuses the engine's real WebSocket server (PubWsServer.cc), the
# same one the Tauri app embeds — main.cpp just starts it and blocks. The old
# hand-written ws_server.cc was built against the removed single-publisher C ABI
# and is intentionally NOT compiled. PubWsServer.cc lives in the executable
# target because it needs the uWS/uSockets includes (the engine lib does not).
add_executable(sv_publisher_service
    ${CMAKE_CURRENT_SOURCE_DIR}/main.cpp
    ${NATIVE}/src/PubWsServer.cc
)
target_include_directories(sv_publisher_service PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${NATIVE}/include
    ${UWS}/src
    ${USOCKETS}/src
    ${THIRD}
)

if(WIN32)
    # ═════════════════════════════════════════════════════════════════════════
    # Windows: libuv eventing for uSockets, Npcap SDK for the GOOSE RX pcap
    # calls, Winsock + libuv system deps. Mirrors src-tauri/build.rs.
    # ═════════════════════════════════════════════════════════════════════════

    # libuv discovery: LIBUV_DIR, else VCPKG_ROOT\installed\<triplet>, else C:\vcpkg.
    if(DEFINED ENV{LIBUV_DIR})
        set(LIBUV_ROOT $ENV{LIBUV_DIR})
    else()
        if(DEFINED ENV{VCPKG_ROOT})
            set(_vcpkg $ENV{VCPKG_ROOT})
        else()
            set(_vcpkg "C:/vcpkg")
        endif()
        if(DEFINED ENV{LIBUV_TRIPLET})
            set(_triplet $ENV{LIBUV_TRIPLET})
        else()
            set(_triplet "x64-windows-static-md")
        endif()
        set(LIBUV_ROOT "${_vcpkg}/installed/${_triplet}")
    endif()
    if(NOT EXISTS "${LIBUV_ROOT}/include/uv.h")
        message(FATAL_ERROR "libuv not found at ${LIBUV_ROOT}. Install: vcpkg install libuv:x64-windows-static-md  (see ../WINDOWS_BUILD.md). Override with LIBUV_DIR/VCPKG_ROOT/LIBUV_TRIPLET.")
    endif()
    # Link name follows the file vcpkg emitted (recent: libuv.lib, older/shared: uv.lib).
    if(EXISTS "${LIBUV_ROOT}/lib/libuv.lib")
        set(LIBUV_LIB "${LIBUV_ROOT}/lib/libuv.lib")
    elseif(EXISTS "${LIBUV_ROOT}/lib/uv.lib")
        set(LIBUV_LIB "${LIBUV_ROOT}/lib/uv.lib")
    else()
        message(FATAL_ERROR "libuv import lib not found under ${LIBUV_ROOT}/lib (expected libuv.lib or uv.lib).")
    endif()

    # Npcap SDK discovery: NPCAP_SDK_DIR, else C:\npcap-sdk.
    if(DEFINED ENV{NPCAP_SDK_DIR})
        set(NPCAP_SDK $ENV{NPCAP_SDK_DIR})
    else()
        set(NPCAP_SDK "C:/npcap-sdk")
    endif()
    if(NOT EXISTS "${NPCAP_SDK}/Include/pcap/pcap.h")
        message(FATAL_ERROR "Npcap SDK not found at ${NPCAP_SDK}. Download the SDK zip from https://npcap.com/#download and extract to C:\\npcap-sdk (or set NPCAP_SDK_DIR).")
    endif()

    set(WIN_DEFS
        LIBUS_NO_SSL LIBUS_USE_LIBUV
        WIN32 _WINDOWS WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0601
        NOMINMAX _CRT_SECURE_NO_WARNINGS _WINSOCK_DEPRECATED_NO_WARNINGS)

    target_compile_definitions(usockets PRIVATE
        LIBUS_NO_SSL LIBUS_USE_LIBUV WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0601 _CRT_SECURE_NO_WARNINGS)
    target_include_directories(usockets PRIVATE ${LIBUV_ROOT}/include)
    target_sources(usockets PRIVATE ${USOCKETS}/src/eventing/libuv.c)

    target_compile_definitions(sv_engine PRIVATE ${WIN_DEFS} UWS_NO_ZLIB)
    target_include_directories(sv_engine PRIVATE ${LIBUV_ROOT}/include ${NPCAP_SDK}/Include)
    target_compile_options(sv_engine PRIVATE /EHsc /MD /O2)

    target_compile_definitions(sv_publisher_service PRIVATE ${WIN_DEFS} UWS_NO_ZLIB)
    target_include_directories(sv_publisher_service PRIVATE ${LIBUV_ROOT}/include)
    target_compile_options(sv_publisher_service PRIVATE /EHsc /MD /O2)

    # wpcap is delay-loaded: GooseReceiver links it, but Npcap installs wpcap.dll
    # under System32\Npcap (off the default search path). A delay-load hook in
    # PcapTx.cc loads it from there on first use, so the EXE still launches.
    target_link_libraries(sv_publisher_service PRIVATE
        sv_engine usockets
        ${LIBUV_LIB}
        ${NPCAP_SDK}/Lib/x64/wpcap.lib
        delayimp
        ws2_32 iphlpapi psapi userenv user32 advapi32 dbghelp)
    target_link_options(sv_publisher_service PRIVATE /DELAYLOAD:wpcap.dll)

else()
    # ═════════════════════════════════════════════════════════════════════════
    # Linux/macOS: epoll/kqueue eventing, system libpcap, pthread, zlib.
    # ═════════════════════════════════════════════════════════════════════════
    find_library(PCAP_LIB pcap REQUIRED)
    find_package(ZLIB REQUIRED)

    target_compile_definitions(usockets PRIVATE LIBUS_NO_SSL LIBUS_USE_EPOLL)
    target_sources(usockets PRIVATE ${USOCKETS}/src/eventing/epoll_kqueue.c)

    target_compile_definitions(sv_engine PRIVATE LIBUS_NO_SSL LIBUS_USE_EPOLL)
    target_compile_options(sv_engine PRIVATE -O2 -fPIC)
    target_link_libraries(sv_engine PUBLIC ${PCAP_LIB} pthread)

    target_compile_definitions(sv_publisher_service PRIVATE LIBUS_NO_SSL LIBUS_USE_EPOLL)
    target_compile_options(sv_publisher_service PRIVATE -O2)
    target_link_libraries(sv_publisher_service PRIVATE sv_engine usockets ZLIB::ZLIB pthread)
endif()
