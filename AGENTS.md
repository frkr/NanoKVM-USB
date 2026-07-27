# AGENTS.md

This document serves as the authoritative reference guide and operational manual for AI coding assistants working on the **NanoKVM-USB** repository.

---

## 🏗️ 1. Repository Architecture Overview

The NanoKVM-USB repository contains three distinct client implementations for interacting with NanoKVM-USB hardware (HDMI video capture + CH9329 USB HID serial controller):

| Directory | Tech Stack | Target Platform | Description |
| --- | --- | --- | --- |
| `browser/` | React, Vite, WebSerial, WebUSB | Web Browsers (Chrome / Chromium) | Web-based client running directly in browser without local software installation. |
| `desktop/` | Electron, Vite, Node `serialport` | macOS, Windows, Linux | Cross-platform desktop app with native video capture backends (`AVFoundation`, `DirectShow`, `V4L2`). |
| `macos/` | Swift, AppKit, AVFoundation | macOS (Apple Silicon / Intel) | Native macOS client with zero external dependencies, low latency, and minimal memory footprint (~11MB). |

---

## 🔌 2. CH9329 Protocol Reference

NanoKVM-USB controls the target computer via the CH9329 serial-to-HID chip connected to serial interface (`Baud Rate: 57600`, 8 data bits, 1 stop bit, no parity, raw mode).

### Packet Framing Structure
Every serial command packet sent to the CH9329 must follow this exact byte framing:
```
[ 0x57, 0xAB, ADDR, CMD, LEN, DATA_0, DATA_1, ..., DATA_N-1, SUM ]
```
- **HEAD**: `0x57 0xAB` (Fixed 2-byte header)
- **ADDR**: `0x00` (Default broadcast/device address)
- **CMD**: Command event code (1 byte)
- **LEN**: Length of `DATA` array in bytes (`0x00` to `0x1A`)
- **DATA**: Payload array (`LEN` bytes)
- **SUM**: Checksum byte = `(0x57 + 0xAB + ADDR + CMD + LEN + sum(DATA)) & 0xFF`

### Command Codes (`CmdEvent`)
- `0x01` (`GET_INFO`): Queries chip firmware version and connection state.
- `0x02` (`SEND_KB_GENERAL_DATA`): Keyboard report (8 bytes: `[modifiers, 0x00, key1, key2, key3, key4, key5, key6]`).
- `0x04` (`SEND_MS_ABS_DATA`): Absolute mouse report (7 bytes):
  - `Byte 0`: `0x02` (Report ID)
  - `Byte 1`: Buttons bitmask (`0x01` Left, `0x02` Right, `0x04` Middle, `0x08` Back, `0x10` Forward)
  - `Byte 2-3`: X coordinate Little-Endian (`0` to `4095`)
  - `Byte 4-5`: Y coordinate Little-Endian (`0` to `4095`)
  - `Byte 6`: Scroll wheel signed byte (`-127` to `127`)
- `0x05` (`SEND_MS_REL_DATA`): Relative mouse report (5 bytes):
  - `Byte 0`: `0x01` (Report ID)
  - `Byte 1`: Buttons bitmask (`0x01` Left, `0x02` Right, etc.)
  - `Byte 2`: Delta X signed byte (`-127` to `127`)
  - `Byte 3`: Delta Y signed byte (`-127` to `127`)
  - `Byte 4`: Scroll wheel signed byte (`-127` to `127`)

---

## 🖱️ 3. Mouse Jiggler Specification

All clients (Web, Desktop, and Native macOS) must implement identical Mouse Jiggler behavior:

1. **Pattern**: Smooth Lemniscate (Figure-8) curve.
   - `FIGURE8_STEPS`: 24 steps
   - `BASE_AMPLITUDE`: 35.0 units (with random ±6.0 variation per animation run)
   - Duration: 5.0 to 10.0 seconds per jiggle sequence
2. **Idle Detection**:
   - Periodic timer checks every `3.0` seconds.
   - Triggers only when user idle time exceeds a random threshold between `30.0` and `60.0` seconds.
   - User mouse moves and clicks update `lastMoveTime` via `moveEventCallback()`, resetting the idle timer.
3. **Report Protocol**:
   - **MANDATORY**: Always dispatches relative mouse reports (`SEND_MS_REL_DATA` / `0x05`) to prevent cursor offset glitches on target OSes regardless of absolute vs relative mode settings.

---

## 🛠️ 4. Build, Packaging & Execution Rules for AI Assistants

### A. Desktop Client (`desktop/`)

#### Build Steps:
1. **Compile Native Capture Helper (macOS)**:
   ```bash
   swiftc -O -o resources/nanokvm-capture native/nanokvm-capture.swift
   ```
   > ⚠️ **CRITICAL FOR AI**: `swiftc` writes clang module caches to `/var/folders/`. In sandboxed terminal environments, compile commands MUST be run with `BypassSandbox: true`.

2. **TypeScript Validation & Vite Bundle**:
   ```bash
   npm run typecheck && npx electron-vite build
   ```
   *(Can run inside standard terminal sandbox)*

3. **Packaging with Electron Builder**:
   ```bash
   npx electron-builder --mac
   ```
   > ⚠️ **CRITICAL FOR AI**: `electron-builder` creates temporary build staging directories in `/var/folders/`. Commands running `electron-builder` MUST be executed with `BypassSandbox: true`.

#### Essential Configuration & Entitlements Pitfalls:
- **macOS Dyld Crash (`Library missing: @rpath/Electron Framework.framework`)**:
  When packaging an app with ad-hoc signing (`identityName=-`) and `hardenedRuntime: true`, macOS Dyld will reject `Electron Framework.framework` at launch due to Team ID mismatch between ad-hoc executable and signed framework.
  **FIX**: Ensure `desktop/build/entitlements.mac.plist` includes:
  ```xml
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  ```

---

### B. Native macOS Client (`macos/`)

#### Build Instructions:
```bash
cd macos && ./build.command
```
- Output bundle: `macos/NanoKVM.app`
- > ⚠️ **CRITICAL FOR AI**: Running `./build.command` executes `swiftc` and MUST be run with `BypassSandbox: true`.

#### Critical Code Principles for Native Swift App:
1. **Main UI Thread Responsiveness (NO Blocking I/O)**:
   - `SerialPort.open()` MUST maintain non-blocking socket mode (`O_NONBLOCK`).
   - **NEVER** issue synchronous `read()` calls on the Main Thread during `open()` or `setupSerial()`. Doing so will hang the application UI on startup for 17+ seconds and trigger a macOS kernel hang crash.
   - Use POSIX `tcflush(fd, TCIFLUSH)` to flush unread input buffers instantly.
   - `SerialPort.getInfo()` must poll asynchronously on a background utility queue (`qos: .utility`) with a max timeout (e.g. 200ms).

2. **Mouse Tracking & Event Handling**:
   - `VideoView.updateTrackingAreas()` must configure tracking options with `[.activeAlways, .mouseMoved, .inVisibleRect]` so cursor movement is captured seamlessly.
   - Immediate Button Dispatch: `mouseDown` and `mouseUp` send packets immediately to minimize latency. Position updates are throttled to 30Hz (`flushMouse`) to prevent serial bus buffer saturation.
   - Off-screen Mouse Up: `handleUp` must NOT guard on `bounds.contains(viewLoc)` to guarantee button releases are always transmitted even if the mouse leaves the window boundary while dragging.

---

### C. Browser Client (`browser/`)

#### Running Dev Server:
```bash
cd browser && npm run dev
```

---

## 📋 5. Maintenance Checklist for AI Assistants

Before declaring any build or code modification complete, perform these mandatory verification checks:

1. **Clean Compilation Check**:
   - For `desktop/`: Run `npm run typecheck` and ensure zero TypeScript errors.
   - For `macos/`: Run `cd macos && ./build.command` (with `BypassSandbox: true`) and verify exit code `0`.
2. **Entitlements Audit**:
   - Check `desktop/build/entitlements.mac.plist` to confirm `disable-library-validation` is active.
3. **Serial I/O Audit**:
   - Verify no synchronous blocking `read` system calls exist in initialization functions on the main thread.
4. **Git Workspace Hygiene**:
   - Do not leave deleted tracked files or uncommitted scratch files in `desktop/` or `macos/`. Use `git status` to verify repository health.
