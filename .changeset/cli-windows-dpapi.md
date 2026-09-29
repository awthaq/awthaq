---
"@awthaq/cli": minor
---

Windows credential backend: `awthaq login` keeps its token as a DPAPI blob (`%APPDATA%\awthaq\credential.dpapi`) protected through PowerShell, with the secret on stdin and never argv. A Windows without PowerShell still falls back to the 0600 file with the warning.
