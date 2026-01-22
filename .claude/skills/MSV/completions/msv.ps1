# MSV (Minimum Safe Version) PowerShell completion script
#
# Installation:
#   Add to your PowerShell profile ($PROFILE):
#
#   # MSV function and completion
#   function msv { bun run "$env:USERPROFILE\.claude\skills\MSV\tools\msv.ts" $args }
#   . "$env:USERPROFILE\.claude\skills\MSV\completions\msv.ps1"
#
# Usage: msv <TAB> to see commands, msv query <TAB> for software names

# Register argument completer for msv command
Register-ArgumentCompleter -CommandName msv -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    # MSV commands
    $commands = @(
        @{ Name = 'query'; Description = 'Query MSV for a single software' }
        @{ Name = 'check'; Description = 'Check compliance for software inventory' }
        @{ Name = 'batch'; Description = 'Query MSV for multiple software from file' }
        @{ Name = 'list'; Description = 'List supported software in catalog' }
        @{ Name = 'stats'; Description = 'Show catalog statistics' }
        @{ Name = 'refresh'; Description = 'Clear API caches' }
        @{ Name = 'db'; Description = 'Manage AppThreat database' }
        @{ Name = 'discover'; Description = 'Discover and add new software' }
        @{ Name = 'help'; Description = 'Show help message' }
    )

    # Common software names
    $software = @(
        'chrome', 'edge', 'firefox', 'brave', 'opera',
        '7zip', 'winrar', 'putty', 'winscp', 'filezilla',
        'wireshark', 'nmap', 'git', 'vscode', 'notepad++',
        'vlc', 'zoom', 'teams', 'slack', 'discord',
        'docker', 'kubernetes', 'terraform', 'ansible',
        'python', 'nodejs', 'java', 'dotnet',
        'office365', 'acrobat', 'vmware', 'virtualbox',
        'splunk', 'crowdstrike', 'curl', 'openssl', 'openssh'
    )

    # Format options
    $formats = @('text', 'json', 'csv', 'markdown')

    # Filter options
    $filters = @('all', 'kev', 'urgent', 'stale', 'undetermined')

    # DB subcommands
    $dbCommands = @('status', 'update')

    # Categories
    $categories = @(
        'browser', 'compression', 'remote_access', 'development',
        'database', 'security', 'office', 'media', 'network', 'virtualization'
    )

    # Parse command line
    $tokens = $commandAst.CommandElements
    $command = if ($tokens.Count -gt 1) { $tokens[1].Extent.Text } else { $null }
    $prevToken = if ($tokens.Count -gt 0) { $tokens[-1].Extent.Text } else { $null }

    # Handle completion based on context
    if ($tokens.Count -le 2 -and -not $wordToComplete.StartsWith('-')) {
        # Complete commands
        $commands | Where-Object { $_.Name -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new(
                $_.Name,
                $_.Name,
                'ParameterValue',
                $_.Description
            )
        }
    }
    elseif ($prevToken -eq '--format' -or $prevToken -eq '-f') {
        # Complete format options
        $formats | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', "Output format: $_")
        }
    }
    elseif ($prevToken -eq '--filter') {
        # Complete filter options
        $filters | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', "Filter: $_")
        }
    }
    elseif ($command -eq 'query' -or $command -eq 'check' -or $command -eq 'discover') {
        # Complete software names
        $software | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', "Software: $_")
        }
    }
    elseif ($command -eq 'db') {
        # Complete db subcommands
        $dbCommands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', "DB command: $_")
        }
    }
    elseif ($command -eq 'list') {
        # Complete categories
        $categories | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', "Category: $_")
        }
    }
    elseif ($wordToComplete.StartsWith('-')) {
        # Complete options
        @('--format', '--verbose', '--force', '--filter', '--help', '--version') |
            Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', "Option: $_")
            }
    }
}

# Also create tab completion for the full bun command if needed
Register-ArgumentCompleter -CommandName bun -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $tokens = $commandAst.CommandElements
    $isRunningMsv = $tokens | Where-Object { $_.Extent.Text -like '*msv.ts*' }

    if ($isRunningMsv) {
        # Delegate to msv completion logic
        # (This is a simplified version - the msv function completion handles most cases)
    }
}

Write-Host "MSV shell completion loaded. Type 'msv <TAB>' to see available commands." -ForegroundColor DarkGray
