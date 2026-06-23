fn main() {
    // Build the C++ native library
    let native_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("native")
        .join("src");
    
    let include_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("native")
        .join("include");
    
    // ═══════════════════════════════════════════════════════════════════════
    // Modular C++ engine. Each module has a single owner; nothing here is a
    // remnant of the old single-publisher codepath.
    // ═══════════════════════════════════════════════════════════════════════
    // Network transmission module (Npcap interface)
    let pcap_tx_src = native_dir.join("PcapTx.cc");
    // Packet encoding module (IEC 61850-9-2LE)
    let sv_encoder_src = native_dir.join("SvEncoder.cc");
    // Statistics tracking module
    let sv_stats_src = native_dir.join("SvStats.cc");
    // Equation processing module
    let equation_processor_src = native_dir.join("equation_processor.cc");
    // Multi-publisher modules
    let sv_publisher_instance_src = native_dir.join("sv_publisher_instance.cc");
    let publisher_controller_src = native_dir.join("PublisherController.cc");
    let shared_buffer_src = native_dir.join("SharedBuffer.cc");
    // CID file export module
    let cid_generator_src = native_dir.join("cid_generator.cc");
    // Fault injection module
    let fault_injector_src = native_dir.join("fault_injector.cc");
    // SPSC bridge between this publisher and the teammate's app
    let spsc_bridge_src = native_dir.join("SpscBridge.cc");
    // ASN.1 BER helpers (used by GOOSE encoder; previously orphan in tree)
    let asn1_ber_src    = native_dir.join("asn1_ber_encoder.cc");
    // GOOSE TX + RX modules
    let goose_encoder_src   = native_dir.join("GooseEncoder.cc");
    let goose_tx_sched_src  = native_dir.join("GooseTxScheduler.cc");
    let goose_receiver_src  = native_dir.join("GooseReceiver.cc");
    let goose_service_src   = native_dir.join("GooseService.cc");
    // C++ WebSocket server — the JS<->C++ connection (mirrors subscriber)
    let pub_ws_src = native_dir.join("PubWsServer.cc");

    // Vendored uWebSockets + uSockets at sibling service/ tree
    let uws_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().unwrap()
        .join("service").join("third_party").join("uWebSockets");
    let usockets_root = uws_root.join("uSockets");

    // Recompile if any source file changes
    println!("cargo:rerun-if-changed={}", pcap_tx_src.display());
    println!("cargo:rerun-if-changed={}", sv_encoder_src.display());
    println!("cargo:rerun-if-changed={}", sv_stats_src.display());
    println!("cargo:rerun-if-changed={}", equation_processor_src.display());
    println!("cargo:rerun-if-changed={}", sv_publisher_instance_src.display());
    println!("cargo:rerun-if-changed={}", publisher_controller_src.display());
    println!("cargo:rerun-if-changed={}", shared_buffer_src.display());
    println!("cargo:rerun-if-changed={}", cid_generator_src.display());
    println!("cargo:rerun-if-changed={}", fault_injector_src.display());
    println!("cargo:rerun-if-changed={}", spsc_bridge_src.display());
    println!("cargo:rerun-if-changed={}", asn1_ber_src.display());
    println!("cargo:rerun-if-changed={}", goose_encoder_src.display());
    println!("cargo:rerun-if-changed={}", goose_tx_sched_src.display());
    println!("cargo:rerun-if-changed={}", goose_receiver_src.display());
    println!("cargo:rerun-if-changed={}", goose_service_src.display());
    println!("cargo:rerun-if-changed={}", pub_ws_src.display());

    // ═══════════════════════════════════════════════════════════════════════
    // uSockets compiled as C (separate cc::Build). The event-loop backend is
    // platform-specific: epoll/kqueue on Unix, libuv on Windows (Windows has
    // no epoll, so uSockets drives its loop through libuv — the upstream
    // supported Windows backend).
    // ═══════════════════════════════════════════════════════════════════════
    #[cfg(target_os = "linux")]
    {
        let mut us = cc::Build::new();
        us.include(usockets_root.join("src"))
          .define("LIBUS_NO_SSL", None)
          .define("LIBUS_USE_EPOLL", None)
          .file(usockets_root.join("src/bsd.c"))
          .file(usockets_root.join("src/context.c"))
          .file(usockets_root.join("src/socket.c"))
          .file(usockets_root.join("src/loop.c"))
          .file(usockets_root.join("src/udp.c"))
          .file(usockets_root.join("src/eventing/epoll_kqueue.c"))
          .flag_if_supported("-O2");
        us.compile("usockets");
    }

    #[cfg(target_os = "windows")]
    {
        let libuv_include = libuv_include_dir();
        let mut us = cc::Build::new();
        us.include(usockets_root.join("src"))
          .include(&libuv_include)            // <uv.h> pulled in by libuv.c
          .define("LIBUS_NO_SSL", None)
          .define("LIBUS_USE_LIBUV", None)
          .define("WIN32_LEAN_AND_MEAN", None)   // keep <windows.h> from pulling winsock v1
          .define("_WIN32_WINNT", Some("0x0601"))// expose Win7+ socket/threading APIs
          .define("_CRT_SECURE_NO_WARNINGS", None)
          .file(usockets_root.join("src/bsd.c"))
          .file(usockets_root.join("src/context.c"))
          .file(usockets_root.join("src/socket.c"))
          .file(usockets_root.join("src/loop.c"))
          .file(usockets_root.join("src/udp.c"))
          .file(usockets_root.join("src/eventing/libuv.c"))
          .flag("/O2");
        us.compile("usockets");
    }

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .file(&pcap_tx_src)
        .file(&sv_encoder_src)
        .file(&sv_stats_src)
        .file(&equation_processor_src)
        .file(&sv_publisher_instance_src)
        .file(&publisher_controller_src)
        .file(&shared_buffer_src)
        .file(&cid_generator_src)
        .file(&fault_injector_src)
        .file(&spsc_bridge_src)
        .file(&asn1_ber_src)
        .file(&goose_encoder_src)
        .file(&goose_tx_sched_src)
        .file(&goose_receiver_src)
        .file(&goose_service_src)
        .file(&pub_ws_src)
        .include(&native_dir)               // source-relative includes
        .include(&include_dir)              // header files
        .include(uws_root.join("src"))      // <App.h> from uWebSockets
        .include(usockets_root.join("src")) // libus.h from uSockets
        .define("LIBUS_NO_SSL", None);
    // Eventing backend must match the uSockets build above (and is read by the
    // uWebSockets headers App.h/Loop.h to pick the right loop integration).
    #[cfg(target_os = "windows")]
    {
        build
            .define("LIBUS_USE_LIBUV", None)
            .define("UWS_NO_ZLIB", None)        // skip permessage-deflate → no zlib dep
            .include(libuv_include_dir());      // <uv.h> reached via libusockets.h
    }
    #[cfg(not(target_os = "windows"))]
    {
        build.define("LIBUS_USE_EPOLL", None);
    }

    // Release-mode optimization flags (all platforms)
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        #[cfg(target_os = "windows")]
        {
            build.flag("/O2").define("NDEBUG", None);
        }
        #[cfg(not(target_os = "windows"))]
        {
            build.flag("-O3").define("NDEBUG", None);
            build.flag("-march=native");
        }
    }

    // Platform-specific compiler flags
    #[cfg(target_os = "windows")]
    {
        build
            .flag("/std:c++17")
            .flag("/EHsc")
            .flag("/MD")            // Use dynamic MSVC runtime
            .define("WIN32", None)
            .define("_WINDOWS", None)
            .define("WIN32_LEAN_AND_MEAN", None)  // <windows.h> never pulls winsock v1
            .define("_WIN32_WINNT", Some("0x0601"))// expose Win7+ APIs (ws2tcpip/libuv)
            .define("NOMINMAX", None)             // keep std::min/max usable
            .define("_CRT_SECURE_NO_WARNINGS", None)
            .define("_WINSOCK_DEPRECATED_NO_WARNINGS", None);

        // libuv (event loop for uSockets). Provide its lib dir, then link it.
        if let Some(lib_dir) = libuv_lib_dir() {
            println!("cargo:rustc-link-search=native={}", lib_dir.display());
        }
        // vcpkg names the lib `uv.lib` for both the static-md and shared builds.
        // Override via LIBUV_LINK only if your libuv was packaged differently.
        let uv_lib = std::env::var("LIBUV_LINK").unwrap_or_else(|_| "uv".to_string());
        println!("cargo:rustc-link-lib={}", uv_lib);

        // Winsock + adapter enumeration (PcapTx/PubWsServer) and libuv's own
        // Windows system dependencies.
        for lib in ["ws2_32", "iphlpapi", "psapi", "userenv", "user32", "advapi32", "dbghelp"] {
            println!("cargo:rustc-link-lib={}", lib);
        }
        // Npcap (wpcap.dll) is loaded dynamically at runtime — no link needed.
    }

    #[cfg(target_os = "linux")]
    {
        build
            .flag("-std=c++17")
            .flag("-fPIC")
            .flag("-pthread")
            .flag("-funroll-loops");
        // Link against libpcap on Linux
        println!("cargo:rustc-link-lib=pcap");
        println!("cargo:rustc-link-lib=pthread");
        println!("cargo:rustc-link-lib=z");   // uWebSockets references zlib
    }

    #[cfg(target_os = "macos")]
    {
        build
            .flag("-std=c++17")
            .flag("-fPIC");
        // Link against libpcap on macOS (pre-installed)
        println!("cargo:rustc-link-lib=pcap");
    }

    build.compile("sv_native");

    // Windows: wpcap and Packet are loaded dynamically at runtime (LoadLibrary/GetProcAddress)
    // Linux/macOS: libpcap is linked directly via cargo:rustc-link-lib above

    tauri_build::build()
}

// ════════════════════════════════════════════════════════════════════════════
// libuv discovery (Windows only)
//
// uSockets needs libuv on Windows. We resolve its headers/libs from, in order:
//   1. LIBUV_DIR    — root of a libuv install (has include/ and lib/)
//   2. VCPKG_ROOT   — uses <root>/installed/<LIBUV_TRIPLET>/{include,lib}
//   3. C:\vcpkg     — the conventional default vcpkg location
// LIBUV_TRIPLET defaults to x64-windows-static-md (static libuv, dynamic CRT).
//
// Install libuv first, e.g.:  vcpkg install libuv:x64-windows-static-md
// See WINDOWS_BUILD.md for the full walkthrough.
// ════════════════════════════════════════════════════════════════════════════
#[cfg(target_os = "windows")]
fn libuv_root() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Ok(dir) = std::env::var("LIBUV_DIR") {
        return PathBuf::from(dir);
    }
    // Default to the static-CRT-dynamic triplet: it links libuv STATICALLY (no
    // uv.dll to ship at runtime) while keeping the /MD dynamic CRT that Rust's
    // MSVC target uses by default — so no CRT-mismatch linker errors.
    //   vcpkg install libuv:x64-windows-static-md
    // Override with LIBUV_TRIPLET (e.g. x64-windows for the shared build).
    let vcpkg = std::env::var("VCPKG_ROOT").unwrap_or_else(|_| "C:\\vcpkg".to_string());
    let triplet = std::env::var("LIBUV_TRIPLET")
        .unwrap_or_else(|_| "x64-windows-static-md".to_string());
    PathBuf::from(vcpkg).join("installed").join(triplet)
}

#[cfg(target_os = "windows")]
fn libuv_include_dir() -> std::path::PathBuf {
    libuv_root().join("include")
}

#[cfg(target_os = "windows")]
fn libuv_lib_dir() -> Option<std::path::PathBuf> {
    let dir = libuv_root().join("lib");
    if dir.exists() { Some(dir) } else { None }
}
