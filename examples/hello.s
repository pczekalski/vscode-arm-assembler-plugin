// hello.s - AArch64 (64-bit ARM) Linux, Raspberry Pi 5 compatible.
//
// Uses raw Linux syscalls only, so it links with either "ld" or "gcc".
// Build:  ARM: Build Current .s File
// Run:    ARM: Build and Run Locally  /  ARM: Upload, Build and Run on Remote Device

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
