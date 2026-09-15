devshell_tmux_status_dir=${DEVSHELL_TMUX_PANE_STATUS_DIR:-}
devshell_tmux_status_file=
devshell_tmux_original_ps0=
devshell_tmux_original_debug_command=
devshell_tmux_armed=0

devshell_tmux_escape_pane() {
  printf '%s' "${DEVSHELL_TMUX_PANE_ID:-${TMUX_PANE:-unknown}}" | /usr/bin/sed -e 's/%/pct_/g' -e 's/[^A-Za-z0-9_.-]/_/g'
}

devshell_tmux_init_status_file() {
  if [ -z "$devshell_tmux_status_dir" ]; then return 0; fi
  /bin/mkdir -p "$devshell_tmux_status_dir" 2>/dev/null || return 0
  escaped=$(devshell_tmux_escape_pane)
  devshell_tmux_status_file="$devshell_tmux_status_dir/$escaped.json"
}

devshell_tmux_write_status() {
  state=$1
  if [ -z "$devshell_tmux_status_file" ]; then devshell_tmux_init_status_file; fi
  if [ -z "$devshell_tmux_status_file" ]; then return 0; fi
  tmp="$devshell_tmux_status_file.${BASHPID:-$$}.$RANDOM.tmp"
  printf '{"state":"%s"}\n' "$state" >"$tmp" 2>/dev/null \
    && /bin/mv -f "$tmp" "$devshell_tmux_status_file" 2>/dev/null || { /bin/rm -f "$tmp" 2>/dev/null || true; true; }
}

devshell_tmux_preexec_bash() {
  if [ "${devshell_tmux_armed:-0}" != 1 ]; then return 0; fi
  devshell_tmux_write_status running
}

devshell_tmux_install_debug_hook_bash() {
  original_spec=$(trap -p DEBUG)
  if [ -n "$original_spec" ]; then
    original_quoted=${original_spec#trap -- }
    original_quoted=${original_quoted% DEBUG}
    eval "devshell_tmux_original_debug_command=$original_quoted"
  fi
  if [ -n "$devshell_tmux_original_debug_command" ]; then
    trap "$devshell_tmux_original_debug_command; devshell_tmux_preexec_bash" DEBUG
  else
    trap 'devshell_tmux_preexec_bash' DEBUG
  fi
}

devshell_tmux_precmd_bash() {
  last_status=${1:-$?}
  if [ -z "$devshell_tmux_status_file" ]; then devshell_tmux_init_status_file; fi
  if [ "${devshell_tmux_armed:-0}" != 1 ]; then
    devshell_tmux_armed=1
    devshell_tmux_write_status idle
    return "$last_status"
  fi
  devshell_tmux_write_status idle
  return "$last_status"
}

devshell_tmux_init_status_file
if [ -z "${devshell_tmux_hook_installed:-}" ]; then
  devshell_tmux_hook_installed=1
  if [ "${BASH_VERSINFO[0]:-0}" -gt 4 ] || { [ "${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then
    devshell_tmux_original_ps0=${PS0-}
    PS0='$(devshell_tmux_preexec_bash)'"$devshell_tmux_original_ps0"
  else
    devshell_tmux_install_debug_hook_bash
  fi
  case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
    declare\ -a\ PROMPT_COMMAND=*|declare\ -a*\ PROMPT_COMMAND=*) PROMPT_COMMAND=(devshell_tmux_precmd_bash "${PROMPT_COMMAND[@]}") ;;
    *) if [ -n "${PROMPT_COMMAND:-}" ]; then PROMPT_COMMAND="devshell_tmux_precmd_bash; ${PROMPT_COMMAND}"; else PROMPT_COMMAND="devshell_tmux_precmd_bash"; fi ;;
  esac
fi
