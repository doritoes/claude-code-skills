#!/bin/bash
# MSV (Minimum Safe Version) bash completion script
#
# Installation:
#   1. Copy to /etc/bash_completion.d/msv
#      or source from ~/.bashrc:
#      source ~/.claude/skills/MSV/completions/msv.bash
#
#   2. Create alias in ~/.bashrc:
#      alias msv="bun run ~/.claude/skills/MSV/tools/msv.ts"
#
# Usage: msv <TAB> to see commands, msv query <TAB> for software names

_msv_completions() {
    local cur prev words cword
    _init_completion || return

    # MSV commands
    local commands="query check batch list stats refresh db discover help"

    # MSV options
    local options="--format --verbose --force --filter --help --version"

    # Format options
    local formats="text json csv markdown"

    # Filter options
    local filters="all kev urgent stale undetermined"

    # DB subcommands
    local db_cmds="status update"

    # Software names from catalog (common ones for fast completion)
    local software="chrome edge firefox brave opera 7zip winrar putty winscp filezilla
        wireshark nmap git vscode notepad++ vlc zoom teams slack discord
        docker kubernetes terraform ansible python nodejs java dotnet
        office365 acrobat flash java silverlight
        vmware virtualbox hyper-v
        splunk crowdstrike carbon_black sentinel_one
        cisco_anyconnect globalprotect forticlient
        mysql postgresql mongodb redis
        apache nginx tomcat iis
        curl wget openssl openssh"

    case "${prev}" in
        msv)
            COMPREPLY=($(compgen -W "${commands}" -- "${cur}"))
            return 0
            ;;
        query|check|discover)
            COMPREPLY=($(compgen -W "${software}" -- "${cur}"))
            return 0
            ;;
        batch)
            # Complete file paths
            _filedir
            return 0
            ;;
        --format|-f)
            COMPREPLY=($(compgen -W "${formats}" -- "${cur}"))
            return 0
            ;;
        --filter)
            COMPREPLY=($(compgen -W "${filters}" -- "${cur}"))
            return 0
            ;;
        db)
            COMPREPLY=($(compgen -W "${db_cmds}" -- "${cur}"))
            return 0
            ;;
        list)
            # Categories
            local categories="browser compression remote_access development
                database security office media network virtualization"
            COMPREPLY=($(compgen -W "${categories}" -- "${cur}"))
            return 0
            ;;
    esac

    # If current word starts with -, complete options
    if [[ "${cur}" == -* ]]; then
        COMPREPLY=($(compgen -W "${options}" -- "${cur}"))
        return 0
    fi

    # Default to commands
    COMPREPLY=($(compgen -W "${commands}" -- "${cur}"))
}

complete -F _msv_completions msv
