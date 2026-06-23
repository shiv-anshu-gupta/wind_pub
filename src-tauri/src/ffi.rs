//! FFI bindings are no longer used — the frontend talks to the C++
//! backend directly over WebSocket (ws://localhost:9100/ws) via the same
//! pattern the subscriber uses. See native/src/PubWsServer.cc.
//!
//! Kept as a placeholder so the `mod ffi;` reference in lib.rs still
//! compiles. Contains nothing.
