typeset -g DEVSHELL_TMUX_STATUS_DIR=${DEVSHELL_TMUX_PANE_STATUS_DIR:-}
typeset -g DEVSHELL_TMUX_STATUS_FILE=
typeset -g DEVSHELL_TMUX_PENDING_FILE=
typeset -g DEVSHELL_TMUX_ACTIVE_TASK=
typeset -gi DEVSHELL_TMUX_SEQ=0
typeset -gi DEVSHELL_TMUX_ACTIVE=0

devshell_tmux_escape_pane() {
  print -rn -- "${DEVSHELL_TMUX_PANE_ID:-${TMUX_PANE:-unknown}}" | sed -e 's/%/pct_/g' -e 's/[^A-Za-z0-9_.-]/_/g'
}

devshell_tmux_init_status_file() {
  [[ -z "$DEVSHELL_TMUX_STATUS_DIR" ]] && return 0
  mkdir -p "$DEVSHELL_TMUX_STATUS_DIR" 2>/dev/null || return 0
  local escaped=$(devshell_tmux_escape_pane)
  DEVSHELL_TMUX_STATUS_FILE="$DEVSHELL_TMUX_STATUS_DIR/$escaped.json"
  DEVSHELL_TMUX_PENDING_FILE="$DEVSHELL_TMUX_STATUS_DIR/$escaped.pending"
  if [[ -f "$DEVSHELL_TMUX_STATUS_FILE" ]]; then
    local current_seq=$(sed -n 's/.*"seq":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DEVSHELL_TMUX_STATUS_FILE" 2>/dev/null | tail -n 1)
    [[ -n "$current_seq" ]] && DEVSHELL_TMUX_SEQ=$current_seq
  fi
}

devshell_tmux_pane_id() { print -rn -- "${DEVSHELL_TMUX_PANE_ID:-${TMUX_PANE:-unknown}}"; }

devshell_tmux_take_pending_task() {
  [[ -z "$DEVSHELL_TMUX_PENDING_FILE" || ! -f "$DEVSHELL_TMUX_PENDING_FILE" ]] && return 0
  local task_id=$(head -n 1 "$DEVSHELL_TMUX_PENDING_FILE" 2>/dev/null)
  rm -f "$DEVSHELL_TMUX_PENDING_FILE" 2>/dev/null || true
  [[ "$task_id" == task-* ]] && print -rn -- "$task_id"
}

devshell_tmux_write_status() {
  local state=$1 exit_code=$2 task_id=${3:-} task_json=null
  [[ -z "$DEVSHELL_TMUX_STATUS_FILE" ]] && return 0
  DEVSHELL_TMUX_SEQ=$((DEVSHELL_TMUX_SEQ + 1))
  [[ -n "$task_id" ]] && task_json="\"$task_id\""
  print -r -- "{\"pane\":\"$(devshell_tmux_pane_id)\",\"state\":\"$state\",\"exit_code\":$exit_code,\"seq\":$DEVSHELL_TMUX_SEQ,\"task_id\":$task_json}" \
    >"$DEVSHELL_TMUX_STATUS_FILE.tmp" 2>/dev/null && mv "$DEVSHELL_TMUX_STATUS_FILE.tmp" "$DEVSHELL_TMUX_STATUS_FILE" 2>/dev/null || true
}

devshell_tmux_preexec_zsh() {
  DEVSHELL_TMUX_ACTIVE=1
  DEVSHELL_TMUX_ACTIVE_TASK=$(devshell_tmux_take_pending_task)
  devshell_tmux_write_status running 0 "$DEVSHELL_TMUX_ACTIVE_TASK"
}

devshell_tmux_precmd_zsh() {
  local last_status=$?
  [[ -z "$DEVSHELL_TMUX_STATUS_FILE" ]] && devshell_tmux_init_status_file
  if (( DEVSHELL_TMUX_ACTIVE )); then
    DEVSHELL_TMUX_ACTIVE=0
    devshell_tmux_write_status exit "$last_status" "$DEVSHELL_TMUX_ACTIVE_TASK"
    DEVSHELL_TMUX_ACTIVE_TASK=
  elif [[ ! -f "$DEVSHELL_TMUX_STATUS_FILE" ]]; then
    devshell_tmux_write_status idle 0 ""
  fi
  return $last_status
}

devshell_tmux_init_status_file
preexec_functions+=(devshell_tmux_preexec_zsh)
precmd_functions+=(devshell_tmux_precmd_zsh)
