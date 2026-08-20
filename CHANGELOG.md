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
- Sidebar and status bar integration
- Values entered in the remote configuration prompts are written to the User settings scope, and any
  workspace override of the same key is refreshed so the Settings editor never disagrees with them
- The configuration wizard also asks for the remote working directory and opens the settings page when it finishes
- The sidebar states whether the password comes from the secret storage or from the settings
