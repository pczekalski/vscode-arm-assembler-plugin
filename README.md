<table width="100%">
  <tr width="100%">
    <td align="left" valign="middle">
      <img src="images/EN-Co-Funded-logo.png" alt="Co-Funded by the European Union" height="64">
    </td>
    <td align="center" valign="middle">
    <h3>Assembler - the DNA of Computers</h3>
    </td>
    <td align="right" valign="middle">
      <img src="images/MultiASM-logo.png" alt="MultiASM" height="64">
    </td>
  </tr>
</table>

<h1 align="center">ARM Assembler Toolbox</h1>

<p align="center">
  ARM plugin for assembler code compilation, linking, size reporting, local execution, and remote build and run on ARM devices directly from Visual Studio Code.
</p>

<p align="center">
  <img alt="VS Code" src="https://img.shields.io/badge/VS%20Code-1.110.0%2B-blue">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  <img alt="ARM Toolchain" src="https://img.shields.io/badge/toolchain-as%20%7C%20ld%20%7C%20gcc%20%7C%20qemu-green">
  <img alt="Remote" src="https://img.shields.io/badge/remote-SSH%20%7C%20Raspberry%20Pi-orange">
  <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-brightgreen">
</p>

ARM Assembler Toolbox is a lightweight Visual Studio Code extension for writing, building and running ARM assembly (`.s`, `.S`, `.asm`) programs with the GNU toolchain.

It provides a minimal, fast workflow similar to PlatformIO, but focused on **pure assembler development** — locally on your workstation, or straight on an ARM board such as a **Raspberry Pi 5** reached over SSH.

<p align="center">
  <img src="images/ARM_VSCode.png" alt="ARM Assembler Toolbox" height="120">
</p>

## Features

- 🔨 Assemble `.s` → `.o`
- 🔗 Link `.o` → executable (`ld` or the `gcc` driver, with optional `-nostartfiles`)
- 📊 Display section sizes (`size`), optionally followed by an ELF report (`readelf`)
- ▶ Run the program locally — natively on ARM hosts, or through QEMU user-mode emulation on x86
- 🌐 Upload, build and run on a remote ARM device over SSH, with the terminal output streamed back
- 🔐 Password kept in the encrypted VS Code secret storage, with SSH host key confirmation
- 🎨 ARM assembly syntax highlighting (AArch64 and AArch32)
- ❗ Clickable assembler errors (Problems panel integration), local **and** remote
- 📌 Status bar buttons and a sidebar with the current toolchain and device state

### 📁 Supported Files

- ARM assembly source files with extensions: `.s`, `.S`, `.asm`

## Requirements

To use **ARM Assembler Toolbox**, ensure the following tools and environment are available.
Only the local build needs a toolchain on your machine — for the remote workflow the toolchain lives on the ARM device.

---

### 🧰 ARM Toolchain

This extension depends on the GNU binutils/gcc toolchain for ARM. The following tools must be installed and accessible from your system `PATH`:

- `as` – assembler
- `ld` – linker (used when **Link With** is `ld`)
- `gcc` – compiler driver used for linking against the C library (used when **Link With** is `gcc`)
- `size` – displays section sizes
- `readelf` – optional, displays the ELF headers, sections and symbols after `size`
- `qemu-aarch64` / `qemu-arm` – runs ARM binaries on a non-ARM host (local run only)

On an **ARM host** (Raspberry Pi, ARM64 Linux workstation) these are the plain, unprefixed tools.
On an **x86 host** they come from a cross toolchain and carry a prefix such as `aarch64-linux-gnu-`, which the extension adds automatically.

#### Installation (Ubuntu / Debian, x86 host, 64-bit ARM target)

```bash
sudo apt update
sudo apt install binutils-aarch64-linux-gnu gcc-aarch64-linux-gnu qemu-user
```

For a 32-bit ARM target:

```bash
sudo apt install binutils-arm-linux-gnueabihf gcc-arm-linux-gnueabihf qemu-user
```

#### Installation (Ubuntu / Debian, running on the ARM device itself)

```bash
sudo apt update
sudo apt install binutils gcc
```

#### Installation (Arch Linux)

```bash
sudo pacman -S aarch64-linux-gnu-binutils aarch64-linux-gnu-gcc qemu-user
```

#### Installation (macOS with Homebrew)

```bash
brew tap messense/macos-cross-toolchains
brew install aarch64-unknown-linux-gnu
brew install qemu
```

Then set the prefix in settings, for example:

```json
"arm-asm-builder.toolchainPrefix": "aarch64-unknown-linux-gnu-"
```

> The assembler shipped with Xcode produces Mach-O objects and does not accept the ELF-oriented
> directives used here, so a GNU cross toolchain is required on macOS. Alternatively, skip the local
> toolchain entirely and use the remote workflow.

#### Installation (Windows)

- Install the **Arm GNU Toolchain** (`aarch64-none-linux-gnu`) or use **MSYS2**
- Ensure all required tools are added to your system `PATH`
- Local *running* of ARM binaries needs QEMU or WSL; the remote workflow works without either

---

### 🖥️ Visual Studio Code

- Visual Studio Code version **1.110.0 or newer**
- This extension must be installed and enabled

---

### 🌐 Remote ARM Device (for remote build and run)

To build and run on a device such as a Raspberry Pi 5, you will need:

- The device reachable over the network, with the SSH server enabled (`sudo raspi-config` → *Interface Options* → *SSH*)
- A user account with a password
- `binutils` and `gcc` installed on the device
- No graphical environment is required — only the command line output is used

Configure the connection with:

```
ARM: Configure Remote Device
```

which asks for **IP address / host name**, **port**, **user name**, **working directory** and
**password**, then opens the settings page so the saved values are visible straight away.

Where those answers end up:

| Value | Stored in |
|-------|-----------|
| Host, port, user name, working directory | Extension settings, **User** scope |
| Password | Encrypted VS Code secret storage, never in `settings.json` |

If the same key is also set in the workspace (`.vscode/settings.json`), that copy is rewritten with
the new value as well. Otherwise the workspace value would keep overriding the User scope and the
Settings editor would disagree with what the prompts just accepted.

On the first connection the SSH host key fingerprint is shown for confirmation and then remembered.

---

### ⚙️ Optional Configuration

If the ARM toolchain is not available in your system `PATH`, you can configure explicit paths in settings:

```json
{
  "arm-asm-builder.assemblerPath": "/path/to/aarch64-linux-gnu-as",
  "arm-asm-builder.linkerPath": "/path/to/aarch64-linux-gnu-ld",
  "arm-asm-builder.gccPath": "/path/to/aarch64-linux-gnu-gcc",
  "arm-asm-builder.sizePath": "/path/to/aarch64-linux-gnu-size",
  "arm-asm-builder.readelfPath": "/path/to/aarch64-linux-gnu-readelf"
}
```

or using settings as described below.

---

## Extension Settings

This extension contributes the following settings under the `arm-asm-builder` namespace.

You can configure them via:

- **Settings UI** → search for `ARM ASM Builder`
- or directly in `settings.json`

---

### ⚙️ Available Settings

#### 🔧 Toolchain

```json
"arm-asm-builder.architecture": "aarch64"
```
Target architecture, `aarch64` (Raspberry Pi 5 with a 64-bit OS) or `arm32`. Drives the default toolchain prefix and the default emulator.

```json
"arm-asm-builder.toolchainPrefix": ""
```
Prefix prepended to `as`, `ld`, `gcc`, `size` and `readelf`, for example `aarch64-linux-gnu-`.
Empty means automatic: no prefix on an ARM host, the matching cross prefix elsewhere.

```json
"arm-asm-builder.assemblerPath": "as"
"arm-asm-builder.linkerPath": "ld"
"arm-asm-builder.gccPath": "gcc"
"arm-asm-builder.sizePath": "size"
"arm-asm-builder.readelfPath": "readelf"
```
Tool names or absolute paths. An absolute path is used as it is, without the prefix.

```json
"arm-asm-builder.useReadelf": false
"arm-asm-builder.readelfFlags": ["-W", "-h", "-s", "-S"]
```
Runs `readelf` on the linked binary right after `size`, locally and on the remote device, and writes its
report to the output channel. Disabled by default. The default flags print the ELF header (`-h`), the
symbol table (`-s`) and the section headers (`-S`) in wide format (`-W`). A missing or failing `readelf`
is only reported as a warning and never fails the build.

---

#### 🧠 Build Configuration

```json
"arm-asm-builder.linkWith": "gcc"
```
Link stage tool:
- `gcc` – the C library stays reachable, so your assembly can call `printf`
- `ld` – freestanding binary that has to use raw syscalls

```json
"arm-asm-builder.useNoStartFiles": true
```
Links with `-nostartfiles`. Recommended for pure assembly programs that define `_start` instead of `main`.

```json
"arm-asm-builder.entrySymbol": "_start"
```
Entry symbol passed to the linker.

```json
"arm-asm-builder.assemblerFlags": ["-g"]
"arm-asm-builder.linkerFlags": []
```
Extra flags, for example `-mcpu=cortex-a76` or `-static`.

```json
"arm-asm-builder.outputDirectory": "build"
```
Directory where build artifacts are stored (`.o`, `.elf`).

---

#### ▶ Local Run

```json
"arm-asm-builder.run.useEmulator": "auto"
```
`auto` runs natively on an ARM host and through QEMU elsewhere; `always` and `never` force the choice.

```json
"arm-asm-builder.run.emulatorPath": ""
```
QEMU user-mode emulator. Empty means `qemu-aarch64` or `qemu-arm` according to the architecture.

```json
"arm-asm-builder.run.emulatorLibraryPath": ""
```
Sysroot passed to QEMU via `-L`, needed for dynamically linked binaries, for example `/usr/aarch64-linux-gnu`.

```json
"arm-asm-builder.run.arguments": []
```
Command line arguments for your program, used locally and remotely.

```json
"arm-asm-builder.run.useIntegratedTerminal": false
```
Run in a VS Code terminal instead of the output channel. Use it for programs that read standard input.

---

#### 🌐 Remote Device

```json
"arm-asm-builder.remote.host": ""
"arm-asm-builder.remote.port": 22
"arm-asm-builder.remote.username": "pi"
```
Address, SSH port and user name of the ARM device.

```json
"arm-asm-builder.remote.password": ""
```
Optional. **Anything put here is stored in clear text.** Prefer **ARM: Set Remote Password**, which uses the encrypted secret storage.

```json
"arm-asm-builder.remote.workingDirectory": "~/arm-asm-builder"
```
Directory on the device where sources are uploaded and built. Created automatically.

```json
"arm-asm-builder.remote.toolchainPrefix": ""
```
Toolchain prefix on the device. Normally empty — a Raspberry Pi builds ARM code natively.

```json
"arm-asm-builder.remote.uploadExtraFiles": []
```
Additional workspace-relative files uploaded next to the current source, for example include files.

```json
"arm-asm-builder.remote.keepFiles": true
```
Keep uploaded sources and binaries on the device after a run.

```json
"arm-asm-builder.remote.connectTimeout": 15000
"arm-asm-builder.remote.strictHostKeyChecking": true
```
Handshake timeout in milliseconds, and host key confirmation on first connection.

---

### 📝 Example Configuration

```json
{
  "arm-asm-builder.architecture": "aarch64",
  "arm-asm-builder.toolchainPrefix": "aarch64-linux-gnu-",
  "arm-asm-builder.linkWith": "ld",
  "arm-asm-builder.useNoStartFiles": true,
  "arm-asm-builder.entrySymbol": "_start",
  "arm-asm-builder.assemblerFlags": ["-g"],
  "arm-asm-builder.outputDirectory": "build",
  "arm-asm-builder.run.useEmulator": "auto",
  "arm-asm-builder.remote.host": "192.168.1.50",
  "arm-asm-builder.remote.port": 22,
  "arm-asm-builder.remote.username": "pi",
  "arm-asm-builder.remote.workingDirectory": "~/arm-asm-builder"
}
```

---

### 💡 Notes

- All tool paths can be either:
  - command names (if available in `PATH`)
  - or absolute paths
- Settings can be defined:
  - globally (user settings)
  - per project (`.vscode/settings.json`)
- Changes take effect immediately (no restart required)

## Commands

| Command | Description |
|---------|-------------|
| `ARM: Build Current .s File` | Assemble and link the active file on this machine |
| `ARM: Build and Run Locally` | Build, then execute natively or under QEMU |
| `ARM: Upload and Build on Remote Device` | Copy the source to the device and build it there |
| `ARM: Upload, Build and Run on Remote Device` | Copy, build and execute on the device, streaming the output back |
| `ARM: Stop Running Program` | Terminate the running local process or remote session |
| `ARM: Configure Remote Device` | Ask for IP, port, user name and password |
| `ARM: Set Remote Password` | Store the SSH password in the encrypted secret storage |
| `ARM: Clear Stored Remote Password` | Remove the stored password |
| `ARM: Test Remote Connection` | Log in, report `uname -a` and the assembler version |
| `ARM: Open Settings` | Open the settings of this extension |

## Example

Below is a minimal AArch64 program that prints a line of text using Linux syscalls, so it links
with either `ld` or `gcc`. It runs on a **Raspberry Pi 5** with a 64-bit OS and, locally, under QEMU.

Create a file named `hello.s`:

```asm
// hello.s - AArch64 Linux

        .equ SYS_WRITE, 64
        .equ SYS_EXIT,  93
        .equ STDOUT,    1

        .section .rodata
message:
        .ascii  "Hello from ARM assembly!\n"
        .equ    message_len, . - message

        .text
        .global _start

_start:
        mov     x0, #STDOUT             // fd
        adrp    x1, message             // page address of the string
        add     x1, x1, :lo12:message   // exact address of the string
        mov     x2, #message_len        // byte count
        mov     x8, #SYS_WRITE          // write(2)
        svc     #0

        mov     x0, #0                  // exit status
        mov     x8, #SYS_EXIT           // exit(2)
        svc     #0
```

### How to run locally

1. Open `hello.s` in Visual Studio Code
2. Click **ARM Build** in the status bar or run:
   ```text
   ARM: Build Current .s File
   ```
3. Execute it:
   ```text
   ARM: Build and Run Locally
   ```

The output channel shows the invoked commands, the section sizes and the program output:

```text
> aarch64-linux-gnu-as -g -o build/hello.o hello.s
> aarch64-linux-gnu-ld -e _start build/hello.o -o build/hello.elf

SIZE:
   text	   data	    bss	    dec	    hex	filename
     61	      0	      0	     61	     3d	build/hello.elf

BUILD OK -> build/hello.elf

RUN:
> qemu-aarch64 build/hello.elf
Hello from ARM assembly!

PROGRAM FINISHED (exit code 0)
```

### How to run on a Raspberry Pi 5

1. Run `ARM: Configure Remote Device` and enter the IP address, port, user name and password
2. Confirm the host key fingerprint shown on the first connection
3. Run:
   ```text
   ARM: Upload, Build and Run on Remote Device
   ```

The source is copied over SFTP into the remote working directory, assembled and linked with the
toolchain of the device, and executed there. Everything the program writes to standard output and
standard error appears in the **ARM ASM Builder** output channel.

### Notes

- The example uses `write(2)` and `exit(2)` directly, so no C library is needed.
- Set `arm-asm-builder.linkWith` to `gcc` if you want to call C library functions such as `printf`.
- Dynamically linked binaries executed under QEMU need `arm-asm-builder.run.emulatorLibraryPath`,
  for example `/usr/aarch64-linux-gnu`, or link with `-static`.

## Known Issues

- Linking errors (e.g. an undefined label) do not guide you to the source file when clicking an error in the output console, because `ld` reports section offsets rather than source positions.
- Programs that read from standard input need `arm-asm-builder.run.useIntegratedTerminal` for local runs; remote runs are non-interactive.
- Only the active file is assembled. Multi-file projects need a build system of their own; extra files can still be shipped to the device with `arm-asm-builder.remote.uploadExtraFiles`.
- The `.s` extension is shared with other assembler extensions. If both this and an AVR extension are installed, pick the language mode per file in the status bar.

## Release Notes

### 0.1.0

Initial release: local build and run with QEMU support, remote build and run over SSH, ARM syntax highlighting, sidebar and status bar integration.

## About the project:

<img src="images/EN-Co-Funded-logo.png" alt="Co-Funded by the European Union" height="64">
The MultiASM project has been co-funded by the European Union. Views and opinions expressed are however those of the author or authors only and do not necessarily reflect those of the European Union or the Foundation for the Development of the Education System. Neither the European Union nor the entity providing the grant can be held responsible for them.

[MultiASM website](https://multiasm.eu)

KA220-HED – Cooperation partnerships in higher education

Project ID: 2023-1-PL01-KA220-HED-000152401

Project implementation period: from 2023.12.01 to 2026.11.30 (36m)

**Enjoy!**
