#
# substation_kit/CMakeLists.txt
# ─────────────────────────────
# Static library Shivani's app links against.
#
# Usage from her project's root CMakeLists.txt:
#
#   add_subdirectory(substation_kit)
#   target_link_libraries(her_app PRIVATE substation_kit)
#
# Headers she needs are exposed via target_include_directories(PUBLIC),
# so anything that links substation_kit automatically sees SubstationKit.h.
#
cmake_minimum_required(VERSION 3.16)
project(substation_kit VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Path to the publisher backend whose sources we reuse.
# Override with -DSUBSTATION_PUBLISHER_NATIVE=/path/to/native if her
# checkout layout differs.
set(SUBSTATION_PUBLISHER_NATIVE "${CMAKE_CURRENT_SOURCE_DIR}/../native"
    CACHE PATH "Path to publisher's native/ folder")

find_library(PCAP_LIB pcap REQUIRED)

add_library(substation_kit STATIC
    src/SubstationKit.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/asn1_ber_encoder.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/SvEncoder.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/SvStats.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/GooseEncoder.cc
    # GOOSE TX/RX service stack + the SPSC bridge it needs. The bridge is used
    # ONLY by GOOSE here (TX pulls the boolean, RX pushes decoded booleans).
    # SV is equation-driven and does NOT touch the bridge.
    ${SUBSTATION_PUBLISHER_NATIVE}/src/GooseTxScheduler.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/GooseReceiver.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/GooseService.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/SpscBridge.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/PcapTx.cc
    # Multi-publisher SV stack — equation-driven: the SharedBuffer is the
    # working buffer between each SvPublisherInstance and the writer thread.
    ${SUBSTATION_PUBLISHER_NATIVE}/src/PublisherController.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/SharedBuffer.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/sv_publisher_instance.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/equation_processor.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/fault_injector.cc
    ${SUBSTATION_PUBLISHER_NATIVE}/src/cid_generator.cc
)

target_include_directories(substation_kit PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${SUBSTATION_PUBLISHER_NATIVE}/include
    # equation_processor.h lives in native/src and is included by bare name
    # from sv_publisher_instance.h, so src must be on the header search path.
    ${SUBSTATION_PUBLISHER_NATIVE}/src
)

target_link_libraries(substation_kit PUBLIC
    ${PCAP_LIB}
    pthread
)

target_compile_options(substation_kit PRIVATE -O2 -Wall -Wno-interference-size)

# Build the example next to the library so she can confirm everything
# compiles before integrating into her real project.
add_executable(substation_kit_example example/sim_example.cpp)
target_link_libraries(substation_kit_example PRIVATE substation_kit)
