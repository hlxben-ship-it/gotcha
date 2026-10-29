# Refresh PATH so a freshly winget-installed yt-dlp/ffmpeg is found, then start Gotcha.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
Set-Location $PSScriptRoot
Start-Process "http://localhost:3006"
node server.js
