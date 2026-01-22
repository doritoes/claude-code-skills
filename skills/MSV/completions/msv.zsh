#compdef msv
# MSV (Minimum Safe Version) zsh completion script
#
# Installation:
#   1. Add to fpath in ~/.zshrc (before compinit):
#      fpath=(~/.claude/skills/MSV/completions $fpath)
#
#   2. Or copy to a directory already in fpath:
#      cp msv.zsh /usr/local/share/zsh/site-functions/_msv
#
#   3. Create alias in ~/.zshrc:
#      alias msv="bun run ~/.claude/skills/MSV/tools/msv.ts"

_msv() {
    local -a commands options formats filters db_cmds categories software

    commands=(
        'query:Query MSV for a single software'
        'check:Check compliance for software inventory'
        'batch:Query MSV for multiple software from file'
        'list:List supported software in catalog'
        'stats:Show catalog statistics'
        'refresh:Clear API caches'
        'db:Manage AppThreat database'
        'discover:Discover and add new software'
        'help:Show help message'
    )

    options=(
        '--format[Output format]:format:(text json csv markdown)'
        '--verbose[Enable verbose output]'
        '--force[Force refresh, bypass cache]'
        '--filter[Filter batch results]:filter:(all kev urgent stale undetermined)'
        '--help[Show help]'
        '--version[Show version]'
    )

    formats=(text json csv markdown)
    filters=(all kev urgent stale undetermined)
    db_cmds=(status update)

    categories=(
        'browser:Web browsers'
        'compression:Archive utilities'
        'remote_access:Remote access tools'
        'development:Development tools'
        'database:Database software'
        'security:Security software'
        'office:Office applications'
        'media:Media players'
        'network:Network utilities'
        'virtualization:Virtualization software'
    )

    # Common software for quick completion
    software=(
        'chrome:Google Chrome'
        'edge:Microsoft Edge'
        'firefox:Mozilla Firefox'
        'brave:Brave Browser'
        '7zip:7-Zip'
        'winrar:WinRAR'
        'putty:PuTTY'
        'winscp:WinSCP'
        'filezilla:FileZilla'
        'wireshark:Wireshark'
        'git:Git for Windows'
        'vscode:Visual Studio Code'
        'python:Python'
        'nodejs:Node.js'
        'docker:Docker Desktop'
        'zoom:Zoom'
        'teams:Microsoft Teams'
        'slack:Slack'
        'vlc:VLC Media Player'
        'notepad++:Notepad++'
        'curl:curl'
        'openssl:OpenSSL'
    )

    case $state in
        (command)
            _describe -t commands 'msv command' commands
            ;;
        (software)
            _describe -t software 'software name' software
            ;;
    esac

    _arguments -C \
        '1: :->command' \
        '*: :->args' \
        $options

    case $state in
        (command)
            _describe -t commands 'msv command' commands
            ;;
        (args)
            case $words[2] in
                (query|check|discover)
                    _describe -t software 'software name' software
                    ;;
                (batch)
                    _files
                    ;;
                (list)
                    _describe -t categories 'category' categories
                    ;;
                (db)
                    _describe -t db_cmds 'db command' db_cmds
                    ;;
            esac
            ;;
    esac
}

_msv "$@"
