# psmux upstream

Vendored from https://github.com/psmux/psmux at commit
`2c5ee9570b32a77a5c14c017b2c30d91d328de0f` (psmux 3.3.8).

The upstream MIT license is preserved in `LICENSE`.

The devshell copy is linked into `devshell-worker` on Windows. Its binary entrypoint
is exposed as a library function so the worker can self-reexec into the persistent
psmux client/server role without shipping a separate `psmux.exe`. Vendored text is
normalized to LF with trailing whitespace removed; no runtime behavior is changed by
that normalization.

Local integration changes are intentionally narrow:

- expose the psmux CLI entrypoint as `psmux::run()`;
- report `#{pane_pipe}` from the live pipe-pane registry so devshell can verify
  managed-task transcript capture.
