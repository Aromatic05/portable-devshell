set -g __devshell_tmux_status_dir $DEVSHELL_TMUX_PANE_STATUS_DIR
set -g __devshell_tmux_status_file ''
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

function __devshell_tmux_init_status_file
    if test -z "$__devshell_tmux_status_dir"
        return 0
    end
    /bin/mkdir -p "$__devshell_tmux_status_dir" 2>/dev/null; or return 0
    set -l escaped (__devshell_tmux_escape_pane)
    set -g __devshell_tmux_status_file "$__devshell_tmux_status_dir/$escaped.json"
end

function __devshell_tmux_write_status
    set -l state $argv[1]
    set -l exit_code $argv[2]
    if test -z "$__devshell_tmux_status_file"
        __devshell_tmux_init_status_file
    end
    if test -z "$__devshell_tmux_status_file"
        return 0
    end
    set -l tmp "$__devshell_tmux_status_file.$fish_pid."(random)'.tmp'
    printf '{"state":"%s","exit_code":%s}\n' "$state" "$exit_code" >"$tmp" 2>/dev/null
    and /bin/mv -f "$tmp" "$__devshell_tmux_status_file" 2>/dev/null
    or begin
        /bin/rm -f "$tmp" 2>/dev/null
        true
    end
end

function __devshell_tmux_preexec --on-event fish_preexec
    set -g __devshell_tmux_active 1
    __devshell_tmux_write_status running 0
end

function __devshell_tmux_postexec --on-event fish_postexec
    set -l last_status $status
    if test "$__devshell_tmux_active" -eq 1
        set -g __devshell_tmux_active 0
        __devshell_tmux_write_status exit "$last_status"
    end
end

__devshell_tmux_init_status_file
if not test -f "$__devshell_tmux_status_file"
    __devshell_tmux_write_status idle 0
end
