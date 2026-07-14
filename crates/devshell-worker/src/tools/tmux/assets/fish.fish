set -g __devshell_tmux_status_dir $DEVSHELL_TMUX_PANE_STATUS_DIR
set -g __devshell_tmux_status_file ''
set -g __devshell_tmux_pending_file ''
set -g __devshell_tmux_active_task ''
set -g __devshell_tmux_seq 0
set -g __devshell_tmux_active 0

function __devshell_tmux_escape_pane
    set -l pane $DEVSHELL_TMUX_PANE_ID
    if test -z "$pane"
        set pane $TMUX_PANE
    end
    if test -z "$pane"
        set pane unknown
    end
    string replace -a '%' 'pct_' -- "$pane" | string replace -ar '[^A-Za-z0-9_.-]' '_'
end

function __devshell_tmux_pane_id
    if test -n "$DEVSHELL_TMUX_PANE_ID"
        printf '%s' "$DEVSHELL_TMUX_PANE_ID"
    else if test -n "$TMUX_PANE"
        printf '%s' "$TMUX_PANE"
    else
        printf '%s' unknown
    end
end

function __devshell_tmux_init_status_file
    if test -z "$__devshell_tmux_status_dir"
        return 0
    end
    mkdir -p "$__devshell_tmux_status_dir" 2>/dev/null; or return 0
    set -l escaped (__devshell_tmux_escape_pane)
    set -g __devshell_tmux_status_file "$__devshell_tmux_status_dir/$escaped.json"
    set -g __devshell_tmux_pending_file "$__devshell_tmux_status_dir/$escaped.pending"
    if test -f "$__devshell_tmux_status_file"
        set -l current_seq (sed -n 's/.*"seq":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$__devshell_tmux_status_file" 2>/dev/null | tail -n 1)
        if string match -qr '^[0-9]+$' -- "$current_seq"
            set -g __devshell_tmux_seq $current_seq
        end
    end
end

function __devshell_tmux_take_pending_task
    if test -z "$__devshell_tmux_pending_file"; or not test -f "$__devshell_tmux_pending_file"
        return 0
    end
    set -l task_id (head -n 1 "$__devshell_tmux_pending_file" 2>/dev/null)
    rm -f "$__devshell_tmux_pending_file" 2>/dev/null
    if string match -qr '^task-[A-Za-z0-9-]+$' -- "$task_id"
        printf '%s' "$task_id"
    end
end

function __devshell_tmux_write_status
    set -l state $argv[1]
    set -l exit_code $argv[2]
    set -l task_id $argv[3]
    if test -z "$__devshell_tmux_status_file"
        __devshell_tmux_init_status_file
    end
    if test -z "$__devshell_tmux_status_file"
        return 0
    end
    set -g __devshell_tmux_seq (math "$__devshell_tmux_seq + 1")
    set -l tmp "$__devshell_tmux_status_file.$fish_pid."(random)'.tmp'
    set -l task_json null
    if test -n "$task_id"
        set task_json "\"$task_id\""
    end
    printf '{"pane":"%s","state":"%s","exit_code":%s,"seq":%s,"task_id":%s}\n' \
        (__devshell_tmux_pane_id) "$state" "$exit_code" "$__devshell_tmux_seq" "$task_json" \
        >"$tmp" 2>/dev/null
    and mv -f "$tmp" "$__devshell_tmux_status_file" 2>/dev/null
    or begin
        rm -f "$tmp" 2>/dev/null
        true
    end
end

function __devshell_tmux_preexec --on-event fish_preexec
    set -g __devshell_tmux_active 1
    set -g __devshell_tmux_active_task (__devshell_tmux_take_pending_task)
    __devshell_tmux_write_status running 0 "$__devshell_tmux_active_task"
end

function __devshell_tmux_postexec --on-event fish_postexec
    set -l last_status $status
    if test "$__devshell_tmux_active" -eq 1
        set -g __devshell_tmux_active 0
        __devshell_tmux_write_status exit "$last_status" "$__devshell_tmux_active_task"
        set -g __devshell_tmux_active_task ''
    end
end

__devshell_tmux_init_status_file
if not test -f "$__devshell_tmux_status_file"
    __devshell_tmux_write_status idle 0 ''
end
