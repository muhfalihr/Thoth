#requires -Version 5.1
<#
.SYNOPSIS
  Thoth end-to-end runner: OpenClaw content-sourcing (discover -> pipeline -> validate)
  then Thoth render. One file that chains the whole RUNBOOK (openclaw/RUNBOOK.md).

.DESCRIPTION
  - OpenClaw node scripts run from the WORKSPACE copy (~/.openclaw/workspace) so paths.js
    writes into that workspace's output/ (paths.js is __dirname-based, not cwd-based).
  - Thoth renders from target\release\thoth.exe in this repo.
  - Foreground/synchronous on purpose: no premature "stuck" kill like Ella's polling (Bug 3).
    build_footage can be silent for minutes per object - that is NORMAL, let it run.

.EXAMPLE
  .\run_full.ps1
      Discovery only: list candidate reels + their URLs, then exit.

.EXAMPLE
  .\run_full.ps1 -Url "https://www.instagram.com/acct/reel/CODE/"
      Full pipeline -> validate -> render for the chosen reel.

.EXAMPLE
  .\run_full.ps1 -Url "<URL>" -Extra "https://www.tiktok.com/@kumparan/video/123" -SkipRender
#>
[CmdletBinding()]
param(
  [string]   $Url       = "",
  [switch]   $Discover,
  [int]      $Hours     = 48,
  [int]      $MaxPer    = 4,
  [int]      $Per       = 2,
  [int]      $Max       = 4,
  [int]      $Cap       = 12,
  [string[]] $Extra     = @(),
  [string]   $Provider  = "novita",
  [switch]   $SkipRender,
  [string]   $Workspace = "$env:USERPROFILE\.openclaw\workspace"
)

$ErrorActionPreference = "Stop"

$repo       = $PSScriptRoot
$thoth      = Join-Path $repo "target\release\thoth.exe"
$contentRel = "thoth_content_set.json"
$contentSet = Join-Path $Workspace "output\$contentRel"
$reelTopics = Join-Path $Workspace "output\reel_topics.json"

function Step([string]$n,[string]$msg){ Write-Host "`n=== [$n] $msg ===" -ForegroundColor Cyan }
function Ok([string]$m){ Write-Host $m -ForegroundColor Green }
function Warn([string]$m){ Write-Host "WARN: $m" -ForegroundColor Yellow }
function Die([string]$m){ Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# Run an OpenClaw node script from the workspace. $rest = string[] of args.
function Invoke-Node([string]$script,[string[]]$rest){
  $p = Join-Path $Workspace $script
  if(-not (Test-Path $p)){ Die "Tidak ketemu: $p  (sudah 'node sync.js push' ke workspace?)" }
  Push-Location $Workspace
  try { & node $p @rest }
  finally { Pop-Location }
}

function Get-Counts {
  if(-not (Test-Path $contentSet)){ return @{ footage = -1; comments = -1 } }
  try {
    $s = Get-Content $contentSet -Raw | ConvertFrom-Json
    # PS 5.1 quirk: ConvertFrom-Json turns an empty [] into $null, so guard before counting.
    $fc = if ($null -eq $s.footage)  { 0 } else { @($s.footage).Count }
    $cc = if ($null -eq $s.comments) { 0 } else { @($s.comments).Count }
    return @{ footage = $fc; comments = $cc }
  } catch { return @{ footage = -1; comments = -1 } }
}

# ── 0. Preflight ───────────────────────────────────────────────────────────────
Step 0 "Preflight"
Write-Host "repo      : $repo"
Write-Host "workspace : $Workspace"
if(-not (Test-Path $Workspace)){ Die "Workspace OpenClaw tak ada: $Workspace" }
if(-not (Test-Path $thoth)){ Warn "thoth.exe belum ada di $thoth - build dulu (build_cuda.bat). Render akan di-skip kalau tetap tak ada." }
try {
  Invoke-WebRequest "http://127.0.0.1:18792/json/version" -TimeoutSec 3 -UseBasicParsing | Out-Null
  Ok "CDP relay 18792: OK"
} catch {
  Warn "CDP relay 18792 DOWN - discovery/scraping akan gagal. Jalankan 'openclaw node start' & attach tab login."
}

# ── 1. Discovery (kalau -Url kosong, atau -Discover) ─────────────────────────────
if($Discover -or [string]::IsNullOrWhiteSpace($Url)){
  Step 1 "Discovery reels (akun kurator IG)"
  Invoke-Node "discover_reels.js" @("--max-per","$MaxPer","--hours","$Hours")
  if(Test-Path $reelTopics){
    try {
      $rt = Get-Content $reelTopics -Raw | ConvertFrom-Json
      Ok "`nTop kandidat (salin salah satu URL):"
      $i = 0
      foreach($x in $rt.reels){
        if($i -ge 6){ break }; $i++
        Write-Host ("  {0}. [{1} | {2} views | {3}] {4}" -f $i,$x.account,$x.views,$x.age,$x.topic)
        Write-Host ("     {0}" -f $x.url) -ForegroundColor DarkGray
      }
    } catch { Warn "Gagal parse $reelTopics" }
  }
  Ok "`nLalu jalankan: .\run_full.ps1 -Url `"<URL_reel>`""
  exit 0
}

# ── 2. run_pipeline -> content-set ──────────────────────────────────────────────
Step 2 "run_pipeline (trace_source -> build_footage -> figures -> comments -> validate)"
Warn "build_footage bisa diam beberapa menit/objek - itu NORMAL, JANGAN dihentikan."
Invoke-Node "run_pipeline.js" @($Url,"--out",$contentRel,"--per","$Per","--max","$Max","--cap","$Cap")
if(-not (Test-Path $contentSet)){ Die "content-set tak terbentuk: $contentSet" }

$c = Get-Counts
Write-Host ("footage={0}  comments={1}" -f $c.footage,$c.comments)

# 2b. Fallback kalau footage kosong (run_pipeline ke-kill sebelum footage).
if($c.footage -eq 0){
  Warn "footage kosong - jalankan build_footage + extract_figures terpisah."
  Step "2b" "build_footage + extract_figures"
  Invoke-Node "build_footage.js"   @($contentSet,"--per","$Per","--max","$Max")
  Invoke-Node "extract_figures.js" @($contentSet)
  $c = Get-Counts
  Write-Host ("footage={0}  comments={1}" -f $c.footage,$c.comments)
}

# ── 3. Komentar tambahan (kalau -Extra diberikan) ────────────────────────────────
if($Extra.Count -gt 0){
  Step 3 "collect_comments (sumber tambahan)"
  $a = @($contentSet,"--cap","$Cap")
  foreach($e in $Extra){ $a += @("--extra",$e) }
  Invoke-Node "collect_comments.js" $a
  $c = Get-Counts
  Write-Host ("footage={0}  comments={1}" -f $c.footage,$c.comments)
}

# ── 4. Crop post non-video (idempotent; skip video/sudah ada) ─────────────────────
Step 4 "enrich_image_paths (crop post non-video)"
Invoke-Node "enrich_image_paths.js" @($contentSet,"--force")

# ── 5. Validate (WAJIB lolos) ────────────────────────────────────────────────────
Step 5 "validate_content_set"
Invoke-Node "validate_content_set.js" @($contentSet)
if($LASTEXITCODE -ne 0){ Die "Lint FAIL - perbaiki content-set sebelum render (lihat pesan di atas)." }
$c = Get-Counts
Ok ("Content-set OK: footage={0}  comments={1}" -f $c.footage,$c.comments)
if($c.comments -lt 6){ Warn "comments < 6 - narasi bisa hambar. Tambah '-Extra <url_rame>' lalu ulang." }
if($c.footage  -lt 2){ Warn "footage < 2 - montase tipis. Pertimbangkan turunkan --per/--max gate atau tambah objek." }

# ── 6. Render Thoth ──────────────────────────────────────────────────────────────
if($SkipRender){ Ok "`n-SkipRender: berhenti sebelum render. Content-set: $contentSet"; exit 0 }
if(-not (Test-Path $thoth)){ Die "thoth.exe tak ada ($thoth) - build dulu (build_cuda.bat)." }
Step 6 "Render Thoth (provider=$Provider)"
Warn "URL CDN TikTok ephemeral - render sekarang juga."
Push-Location $repo
try { & $thoth run --content $contentSet --provider $Provider }
finally { Pop-Location }
if($LASTEXITCODE -ne 0){ Die "Thoth render gagal (exit $LASTEXITCODE)." }

# ── 7. Selesai ───────────────────────────────────────────────────────────────────
Step 7 "Selesai"
Ok "Output: $repo\output\.thoth\<job-id>\clips\clip_000_narration.mp4"
Write-Host "Cek log: 'Narrator-driven video: ~45s', 'AI cover', 'Hook title PNG (Pillow)', 'Reaction memes: N placed'."
