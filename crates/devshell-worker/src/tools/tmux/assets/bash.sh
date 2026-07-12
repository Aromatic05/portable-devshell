devshell_tmux_status_dir=${DEVSHELL_TMUX_PANE_STATUS_DIR:-}
devshell_tmux_status_file=
devshell_tmux_original_ps0=
devshell_tmux_armed=0

devshell_tmux_escape_pane() {
  printf '%s' "${DEVSHELL_TMUX_PANE_ID:-${TMUX_PANE:-unknown}}" | sed -e 's/%/pct_/g' -e 's/[^A-Za-z0-9_.-]/_/g'
}

devshell_tmux_pane_id() {
  printf '%s' "${DEVSHELL_TMUX_PANE_ID:-${TMUX_PANE:-unknown}}"
}

devshell_tmux_init_status_file() {
  if [ -z "$devshell_tmux_status_dir" ]; then
    return 0
  fi
  mkdir -p "$devshell_tmux_status_dir" 2>/dev/null || return 0
  devshell_tmux_status_file="$devshell_tmux_status_dir/$(devshell_tmux_escape_pane).json"
}

devshell_tmux_read_seq() {
  if [ -z "$devshell_tmux_status_file" ] || [ ! -f "$devshell_tmux_status_file" ]; then
    printf '0'
    return 0
  fi

  seq=$(sed -n 's/.*"seq":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$devshell_tmux_status_file" 2>/dev/null | tail -n 1)
  case "$seq" in
    ''|*[!0-9]*)
      printf '0'
      ;;
    *)
      printf '%s' "$seq"
      ;;
  esac
}

devshell_tmux_read_state() {
  if [ -z "$devshell_tmux_status_file" ] || [ ! -f "$devshell_tmux_status_file" ]; then
    return 0
  fi

  sed -n 's/.*"state":"\([^"]*\)".*/\1/p' "$devshell_tmux_status_file" 2>/dev/null | tail -n 1
}

devshell_tmux_write_status() {
  state=$1
  exit_code=$2

  if [ -z "$devshell_tmux_status_file" ]; then
    devshell_tmux_init_status_file
  fi
  if [ -z "$devshell_tmux_status_file" ]; then
    return 0
  fi

  seq=$(devshell_tmux_read_seq)
  seq=$((seq + 1))
  tmp="$devshell_tmux_status_file.${BASHPID:-$$}.$RANDOM.tmp"

  {
    printf '{"pane":"%s","state":"%s","exit_code":%s,"seq":%s}\n' \
      "$(devshell_tmux_pane_id)" \
      "$state" \
      "$exit_code" \
      "$seq"
  } >"$tmp" 2>/dev/null && mv -f "$tmp" "$devshell_tmux_status_file" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null || true
    true
  }
}

devshell_tmux_preexec_bash() {
  if [ "${devshell_tmux_armed:-0}" != 1 ]; then
    return 0
  fi

  devshell_tmux_write_status running 0
}

devshell_tmux_precmd_bash() {
  last_status=${1:-$?}

  if [ -z "$devshell_tmux_status_file" ]; then
    devshell_tmux_init_status_file
  fi

  if [ "${devshell_tmux_armed:-0}" != 1 ]; then
    devshell_tmux_armed=1
    devshell_tmux_write_status idle 0
    return "$last_status"
  fi

  state=$(devshell_tmux_read_state)

  if [ "$state" = running ]; then
    devshell_tmux_write_status exit "$last_status"
  elif [ -z "$state" ]; then
    devshell_tmux_write_status idle 0
  fi

  return "$last_status"
}

devshell_tmux_init_status_file

if [ -z "${devshell_tmux_hook_installed:-}" ]; then
  devshell_tmux_hook_installed=1
  devshell_tmux_original_ps0=${PS0-}

  PS0='$(devshell_tmux_preexec_bash)'"$devshell_tmux_original_ps0"

  case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
    declare\ -a\ PROMPT_COMMAND=*|declare\ -a*\ PROMPT_COMMAND=*)
      PROMPT_COMMAND=(devshell_tmux_precmd_bash "${PROMPT_COMMAND[@]}")
      ;;
    *)
      if [ -n "${PROMPT_COMMAND:-}" ]; then
        PROMPT_COMMAND="devshell_tmux_precmd_bash; ${PROMPT_COMMAND}"
      else
        PROMPT_COMMAND="devshell_tmux_precmd_bash"
      fi
      ;;
  esac
fi