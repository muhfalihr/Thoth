#requires -Version 5.1
<#
.SYNOPSIS
  Thoth end-to-end runner: scout content-sourcing (discover -> pipeline -> validate)
  then Thoth render. One file that chains the whole RUNBOOK (scout/RUNBOOK.md).

.DESCRIPTION
  - scout node scripts run straight from scout/ in this repo, so lib/paths.ts writes into
    scout/output/ (lib/paths.ts is __dirname-based, not cwd-based).
  - Thoth renders from target\release\thoth.exe in this repo.
  - Foreground/synchronous on purpose: no premature "stuck" kill.
    build_footage can be silent for minutes per object - that is NORMAL, let it run.

.EXAMPLE
  .\run_full.ps1
      Discovery only: list candidate IG reels + posts + their URLs, then exit.

.EXAMPLE
  .\run_full.ps1 -TikTok
      Discovery + TikTok Studio trending topics (region Indonesia; needs a tiktok.com login tab).
      Use -TikTokRegion "United States" / "all" to change region; -Include reels|posts to narrow.

.EXAMPLE
  .\run_full.ps1 -Url "https://www.instagram.com/acct/reel/CODE/"
      Full pipeline -> validate -> render for the chosen reel.

.EXAMPLE
  .\run_full.ps1 -Url "<URL>" -Extra "https://www.tiktok.com/@kumparan/video/123" -SkipRender

.EXAMPLE
  .\run_full.ps1 -FromStage 6
      Resume: pakai content-set yang sudah ada (scout/output), lewati stage lambat
      (run_pipeline/build_footage) - langsung render. -FromStage 5 = validate+render,
      4 = crop+validate+render. Butuh content-set sudah terbentuk dari run sebelumnya.
#>
[CmdletBinding()]
param(
  [string]   $Url        = "",
  [switch]   $Discover,
  [int]      $Hours      = 48,
  [int]      $MaxPer     = 4,
  [string]   $Include    = "reels,posts",
  [switch]   $TikTok,
  [string]   $TikTokRegion = "Indonesia",
  [int]      $Per       = 2,
  [int]      $Max       = 4,
  [int]      $Cap       = 12,
  [string[]] $Extra     = @(),
  [string]   $Provider  = "novita",
  [int]      $FromStage = 2,
  [switch]   $SkipRender
)

$ErrorActionPreference = "Stop"

# ── Visual identity: "Feather Spine" layout + "Ink & Gold" palette ───────────────
# Shares the terminal look of thoth.exe (src/brand.rs) and scout (scout/lib/ui.ts):
# violet spine ▏ down every line, gold ✓ / amber ⚠ / red ✗ glyphs, dim · detail.
# Codepoints (not literals) keep the glyphs intact under PS 5.1's OEM file read.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$script:UseColor = (-not $env:NO_COLOR) -and (-not [Console]::IsOutputRedirected)
$e = [char]27
$C = @{
  gold   = "$e[38;5;179m"; violet = "$e[38;5;141m"; amber = "$e[33m"
  red    = "$e[31m";       dim    = "$e[90m";       reset = "$e[0m"
}
function Paint([string]$col,[string]$s){ if($script:UseColor){ $C[$col] + $s + $C.reset } else { $s } }
$G_FEATHER = [char]::ConvertFromUtf32(0x1FAB6)  # 🪶
$G_SPINE   = [string][char]0x258F               # ▏
$G_BLOCK   = [string][char]0x2588               # █
$G_OK      = [string][char]0x2713               # ✓
$G_WARN    = [string][char]0x26A0               # ⚠
$G_ERR     = [string][char]0x2717               # ✗
$G_DOT     = [string][char]0x00B7               # ·

$repo       = $PSScriptRoot
$scout      = Join-Path $repo "scout"
$thoth      = Join-Path $repo "target\release\thoth.exe"

# yt-dlp cookies for IG slide/post resolves (igSlideDirectUrl/probeVideo) — same cookies.txt
# Thoth's ingest uses (must carry IG HttpOnly `sessionid`). Inherited by the child node processes.
$cookieTxt = Join-Path $repo "data\cookies.txt"
if (Test-Path $cookieTxt) { $env:YTDLP_COOKIES_FILE = $cookieTxt }
$contentRel = "thoth_content_set.json"
$contentSet = Join-Path $scout "output\$contentRel"
$reelTopics = Join-Path $scout "output\reel_topics.json"

# One spine-prefixed line; leading "`n" in $m become blank lines above it (kept aligned).
function Emit([string]$glyph,[string]$m){
  while($m.StartsWith("`n")){ Write-Host ""; $m = $m.Substring(1) }
  Write-Host ("  " + (Paint 'violet' $G_SPINE) + " " + $glyph + $m)
}
# Stage header: gold block + violet UPPERCASE label (matches src/util/progress.rs stage_header).
function Step([string]$n,[string]$msg){
  Write-Host ""
  Write-Host ("  " + (Paint 'gold' $G_BLOCK) + " " + (Paint 'violet' (("[$n] $msg").ToUpper())))
}
function Ok([string]$m){   Emit ((Paint 'gold'  $G_OK)  + " ") $m }
function Warn([string]$m){ Emit ((Paint 'amber' $G_WARN) + " ") $m }
function Die([string]$m){  Emit ((Paint 'red'   $G_ERR)  + " ") $m; exit 1 }
function Info([string]$m){ Emit '' (Paint 'dim' ($G_DOT + " " + $m)) }   # dim detail line
function Sub([string]$m){  Write-Host ("  " + (Paint 'violet' $G_SPINE) + "   " + $m) }  # indented sub-item

# Run a scout node script straight from scout/. $rest = string[] of args.
function Invoke-Node([string]$script,[string[]]$rest){
  $p = Join-Path $scout $script
  if(-not (Test-Path $p)){ Die "Tidak ketemu: $p" }
  Push-Location $scout
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

# ── Banner ───────────────────────────────────────────────────────────────────────
Write-Host ("  " + $G_FEATHER + "  " + (Paint 'gold' "T H O T H") + "  " + (Paint 'dim' ($G_DOT + " runner")))
Write-Host ("  " + (Paint 'violet' $G_SPINE) + " " + (Paint 'dim' ("scout " + $G_DOT + " validate " + $G_DOT + " render")))
Write-Host ("  " + (Paint 'violet' $G_SPINE))

# ── 0. Preflight ───────────────────────────────────────────────────────────────
Step 0 "Preflight"
Info "repo  : $repo"
Info "scout : $scout"
if(-not (Test-Path $scout)){ Die "Folder scout/ tak ada: $scout" }
if(-not (Test-Path $thoth)){ Warn "thoth.exe belum ada di $thoth - build dulu (build_cuda.bat). Render akan di-skip kalau tetap tak ada." }
try {
  Invoke-WebRequest "http://127.0.0.1:18800/json/version" -TimeoutSec 3 -UseBasicParsing | Out-Null
  Ok "Managed browser CDP 18800: OK"
} catch {
  Warn "Managed browser (CDP 18800) DOWN - discovery/scraping akan gagal. Jalankan 'node scout/lib/browser.ts start' & login tab target."
}

# ── 1. Discovery (kalau -Url kosong, atau -Discover) ─────────────────────────────
if($Discover -or ([string]::IsNullOrWhiteSpace($Url) -and $FromStage -le 2)){
  Step 1 "Discovery topik (reels + post akun kurator IG)"
  $dargs = @("--max-per","$MaxPer","--hours","$Hours","--include",$Include)
  if($TikTok){ $dargs += @("--tiktok","--tiktok-region",$TikTokRegion) }
  Invoke-Node "pipeline/discover_reels.ts" $dargs
  if(Test-Path $reelTopics){
    try {
      $rt = Get-Content $reelTopics -Raw | ConvertFrom-Json
      Ok "`nTop kandidat IG (salin salah satu URL):"
      $i = 0
      foreach($x in $rt.reels){
        if($i -ge 6){ break }; $i++
        $kind = if($x.kind){ $x.kind } else { "reel" }
        Sub ((Paint 'gold' ("{0}." -f $i)) + (" [{0} | {1} | {2} views | {3}] {4}" -f $x.account,$kind,$x.views,$x.age,$x.topic))
        Sub (Paint 'dim' ("   {0}" -f $x.url))
      }
      if($rt.tiktok_trending -and @($rt.tiktok_trending).Count -gt 0){
        Ok "`nTikTok trending (region $TikTokRegion) - seed topik (cari sumber videonya):"
        $j = 0
        foreach($t in $rt.tiktok_trending){
          if($j -ge 8){ break }; $j++
          Sub ((Paint 'gold' ("{0}." -f $t.rank)) + (" [{0}] {1}" -f $t.views,$t.title))
        }
      }
    } catch { Warn ("Gagal baca kandidat dari {0}: {1}" -f $reelTopics, $_.Exception.Message) }
  }
  Ok "`nLalu jalankan: .\run_full.ps1 -Url `"<URL_reel>`""
  exit 0
}

# ── Resume guard: stage > 2 butuh content-set yang sudah ada ─────────────────────
if($FromStage -gt 2){
  if(-not (Test-Path $contentSet)){ Die "FromStage=$FromStage tapi content-set belum ada: $contentSet. Jalankan dari stage 2 dulu (tanpa -FromStage)." }
  Info "FromStage=$FromStage - lewati stage < $FromStage, pakai content-set yang ada."
}

# ── 2. run_pipeline -> content-set ──────────────────────────────────────────────
if($FromStage -le 2){
  Step 2 "run_pipeline (trace_source -> comments -> build_footage -> figures -> validate)"
  Warn "build_footage bisa diam beberapa menit/objek - itu NORMAL, JANGAN dihentikan."
  Invoke-Node "pipeline/run_pipeline.ts" @($Url,"--out",$contentRel,"--per","$Per","--max","$Max","--cap","$Cap")
  if(-not (Test-Path $contentSet)){ Die "content-set tak terbentuk: $contentSet" }

  $c = Get-Counts
  Info ("footage={0}  comments={1}" -f $c.footage,$c.comments)

  # 2b. Fallback kalau footage kosong (run_pipeline ke-kill sebelum footage).
  if($c.footage -eq 0){
    Warn "footage kosong - jalankan build_footage + extract_figures terpisah."
    Step "2b" "build_footage + extract_figures"
    Invoke-Node "pipeline/build_footage.ts"   @($contentSet,"--per","$Per","--max","$Max")
    Invoke-Node "pipeline/extract_figures.ts" @($contentSet)
    $c = Get-Counts
    Info ("footage={0}  comments={1}" -f $c.footage,$c.comments)
  }
}

# ── 3. Komentar tambahan (kalau -Extra diberikan) ────────────────────────────────
if($FromStage -le 3 -and $Extra.Count -gt 0){
  Step 3 "collect_comments (sumber tambahan)"
  $a = @($contentSet,"--cap","$Cap")
  foreach($e in $Extra){ $a += @("--extra",$e) }
  Invoke-Node "pipeline/collect_comments.ts" $a
  $c = Get-Counts
  Info ("footage={0}  comments={1}" -f $c.footage,$c.comments)
}

# ── 4. Crop post non-video (idempotent; skip video/sudah ada) ─────────────────────
if($FromStage -le 4){
  Step 4 "enrich_image_paths (crop post non-video)"
  Invoke-Node "pipeline/enrich_image_paths.ts" @($contentSet,"--force")
}

# ── 5. Validate (WAJIB lolos) ────────────────────────────────────────────────────
if($FromStage -le 5){
  Step 5 "validate_content_set"
  Invoke-Node "pipeline/validate_content_set.ts" @($contentSet)
  if($LASTEXITCODE -ne 0){ Die "Lint FAIL - perbaiki content-set sebelum render (lihat pesan di atas)." }
  $c = Get-Counts
  Ok ("Content-set OK: footage={0}  comments={1}" -f $c.footage,$c.comments)
  if($c.comments -lt 6){ Warn "comments < 6 - narasi bisa hambar. Tambah '-Extra <url_rame>' lalu ulang." }
  if($c.footage  -lt 2){ Warn "footage < 2 - montase tipis. Pertimbangkan turunkan --per/--max gate atau tambah objek." }
}

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
Info "Cek log: 'Narrator-driven video: ~45s', 'AI cover', 'Hook title PNG (Pillow)', 'Reaction memes: N placed'."
