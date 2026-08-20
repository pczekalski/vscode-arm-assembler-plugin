# Change Log

All notable changes to the "arm-assembler" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0]

- Initial release
- Assemble and link ARM assembly (`.s`, `.S`, `.asm`) with the GNU toolchain
- Local execution, natively on ARM hosts or through QEMU user-mode emulation
- Upload, build and run over SSH on a remote ARM device such as a Raspberry Pi 5
- SSH password stored in the encrypted VS Code secret storage, host key confirmation on first use
- ARM assembly syntax highlighting for AArch64 and AArch32
- Clickable assembler diagnostics for local and remote builds
- Optional `readelf` pass after `size`, local and remote, with configurable flags (`-W -h -s -S` by default)
- Editing the remote host, port or user name in the settings moves the stored password to the new device, and a password typed into the settings can be moved into the secret storage on the spot
- The device configuration wizard applies address, port, user name and password as one unit: nothing
  is written until every answer is given, so cancelling leaves the previous device untouched
- Laboratory mode (`arm-asm-builder.remote.laboratoryMode`): on shared computers the whole remote device — address, port, user name and password — is kept in the VS Code session only and never stored, so no student inherits the previous configuration
- Sidebar and status bar integration
- Values entered in the remote configuration prompts are written to the User settings scope, and any
  workspace override of the same key is refreshed so the Settings editor never disagrees with them
- The configuration wizard also asks for the remote working directory and opens the settings page when it finishes
- The sidebar states whether the password comes from the secret storage or from the settings
