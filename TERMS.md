# osmatrix terms of use

_Last updated: 2026-10-20_

osmatrix is free, open-source software published by FritzTech. Using it, including as a plugin in Claude, Codex/ChatGPT or Cursor, means accepting these terms.

## License

osmatrix is licensed under the [MIT License](LICENSE). It is provided "as is", without warranty of any kind. FritzTech is not liable for any damage or data loss arising from its use.

## Your responsibilities

osmatrix creates, modifies and deletes virtual machines, containers, disks and files on your computer. It can also run commands and CI workflows that you, or an AI agent acting for you, request. You are responsible for:

- reviewing what your agent runs, and keeping backups of anything important;
- the code and workflows you execute inside guests, and any services they contact;
- having the right to use every operating system and piece of software that osmatrix installs for you.

## Third-party software

osmatrix downloads and installs third-party software, each under its own license:

- **Windows:** Windows Server evaluation editions, under Microsoft's evaluation terms (time-limited, for evaluation and testing).
- **macOS:** Apple's [macOS Software License Agreement](https://www.apple.com/legal/sla/). It permits macOS only on Apple-branded hardware. osmatrix asks for your explicit consent before installing macOS and records it in your configuration. Running macOS guests on non-Apple hardware is at your own risk.
- **Visual Studio Build Tools** (Windows guests, unless `msvc = false`): Microsoft's license terms for the Visual Studio Build Tools, shown by its installer.
- **Xcode Command Line Tools** (macOS guests): Apple's Xcode and Apple SDKs agreement.
- **Others:** container images (such as `catthehacker/ubuntu` and dockur's), the cirruslabs macOS images used by tart, `act`, Node.js, Python, Git, PowerShell and Homebrew, each under its publisher's license.

## Changes

These terms may be updated. The current version is always at https://github.com/fritz-fritz/osmatrix/blob/main/TERMS.md.

## Contact

https://github.com/fritz-fritz/osmatrix/issues
