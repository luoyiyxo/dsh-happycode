# Checks that the running DSH host actually serves HappyCode.
#
#   pwsh -File scripts/verify-live.ps1 [-BaseUrl http://127.0.0.1:49116]
#
# Exit code 0 means every route answered. Run it after restarting DSH.

param(
    [string]$BaseUrl = 'http://127.0.0.1:49116'
)

$ErrorActionPreference = 'Stop'

function Get-Json($path) {
    $response = Invoke-WebRequest -Uri "$BaseUrl$path" -UseBasicParsing -TimeoutSec 20
    return $response.Content | ConvertFrom-Json
}

Write-Host "host: $BaseUrl"

$status = Get-Json '/dsh-happycode/api/status'
Write-Host ''
Write-Host 'status' -ForegroundColor Green
Write-Host ("  sessions indexed : {0}" -f $status.sessions)
Write-Host ("  active days      : {0}" -f $status.days)
Write-Host ("  zone             : {0}" -f $status.timeZone)
Write-Host ("  cache built      : {0}" -f ([datetimeoffset]::FromUnixTimeMilliseconds([int64]$status.builtAt).LocalDateTime))
Write-Host ("  zstd available   : {0}" -f $status.zstd)
Write-Host ("  unreadable logs  : {0}" -f @($status.errors).Count)

$year = (Get-Date).Year
$graph = Get-Json "/dsh-happycode/api/graph?year=$year"
Write-Host ''
Write-Host "by year $year" -ForegroundColor Green
Write-Host ("  total            : {0}" -f $graph.total)
Write-Host ("  active days      : {0}" -f $graph.activeDays)
Write-Host ("  thresholds       : {0}" -f ($graph.thresholds -join ' / '))
Write-Host ("  available years  : {0}" -f ($graph.availableYears -join ', '))
foreach ($day in $graph.days) {
    Write-Host ("  {0}  m={1,-4} t={2,-4} f={3,-4} value={4,-5} level={5}" -f $day.date, $day.m, $day.t, $day.f, $day.value, $day.level)
}

$rolling = Get-Json '/dsh-happycode/api/graph?range=last365'
Write-Host ''
Write-Host 'last year' -ForegroundColor Green
Write-Host ("  window           : {0} .. {1}" -f $rolling.start, $rolling.end)
Write-Host ("  total            : {0}" -f $rolling.total)

$settings = Get-Json '/dsh-happycode/api/settings'
Write-Host ''
Write-Host 'settings' -ForegroundColor Green
Write-Host ("  weights          : m={0} t={1} f={2}" -f $settings.weights.m, $settings.weights.t, $settings.weights.f)

Write-Host ''
Write-Host 'all routes answered' -ForegroundColor Green
