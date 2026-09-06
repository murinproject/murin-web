[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$prettierCommand = Join-Path $repositoryRoot "node_modules\.bin\prettier.cmd"
$prettierTargets = @(
    "package.json",
    "package-lock.json",
    "server/**/*.js",
    "server/**/*.json",
    "server/**/*.css",
    "server/**/*.html",
    "server/**/*.md",
    "server/**/*.yaml",
    "server/**/*.yml"
)
$prettierArguments = @(
    $(if ($Check) { "--check" } else { "--write" }),
    "--ignore-unknown",
    "--no-error-on-unmatched-pattern",
    "--ignore-path",
    (Join-Path $repositoryRoot ".gitignore")
)
$prettierArguments += $prettierTargets

Push-Location $repositoryRoot
try {
    if (Test-Path -LiteralPath $prettierCommand) {
        Write-Host "Using local Prettier: $prettierCommand"
        & $prettierCommand @prettierArguments
    }
    else {
        if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
            throw "Prettier is not installed and npx is unavailable. Install Node.js or add Prettier to server devDependencies."
        }

        Write-Host "Local Prettier not found; using prettier@3.6.2 through npx."
        & npx --yes prettier@3.6.2 @prettierArguments
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Prettier failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
