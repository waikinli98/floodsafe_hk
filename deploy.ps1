# Deploy FloodSafe HK to Cloud Run from Windows (PowerShell). Same steps as deploy.sh.
# Calls gcloud.cmd (not the gcloud.ps1 wrapper, which turns gcloud's stderr into script-stopping errors).
# Usage (in the project folder):  powershell -ExecutionPolicy Bypass -File deploy.ps1 -ProjectId floodsafehk
param(
  [string]$ProjectId = $(gcloud.cmd config get-value project 2>$null),
  [string]$Region = "asia-east2",          # Hong Kong
  [string]$Service = "floodsafe-hk",
  [switch]$SkipSetup                        # only rebuild + redeploy
)
# gcloud.cmd writes progress to stderr; PowerShell 5 would treat that as fatal, so rely on exit codes instead
$ErrorActionPreference = "Continue"
if (-not $ProjectId) { throw "Set -ProjectId or run: gcloud.cmd config set project YOUR_PROJECT" }

# Read keys from .env without printing them
$envVars = @{}
if (Test-Path .env) {
  Get-Content .env | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2; $envVars[$k] = $v.Trim()
  }
}
$serverKey = if ($env:MAPS_SERVER_KEY) { $env:MAPS_SERVER_KEY } else { $envVars['MAPS_SERVER_KEY'] }
if (-not $serverKey) { throw "MAPS_SERVER_KEY missing (.env or environment)" }
$browserKey = if ($envVars['MAPS_BROWSER_KEY']) { $envVars['MAPS_BROWSER_KEY'] } else { $serverKey }
if ($browserKey -eq $serverKey) { Write-Warning "MAPS_BROWSER_KEY is the same as MAPS_SERVER_KEY. The browser key is visible to every visitor, so use a separate key restricted to your website (HTTP referrers) and the Maps JavaScript API only." }
$model = if ($envVars['GEMINI_MODEL']) { $envVars['GEMINI_MODEL'] } else { 'gemini-3.5-flash' }
$fallback = if ($envVars['GEMINI_FALLBACK_MODELS']) { $envVars['GEMINI_FALLBACK_MODELS'] } else { 'gemini-3.5-flash-lite,gemini-flash-latest' }
$mapId = if ($envVars['MAP_ID']) { $envVars['MAP_ID'] } else { 'DEMO_MAP_ID' }

function Run([string]$what, [scriptblock]$cmd) {
  Write-Host "> $what" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "Failed: $what" }
}

gcloud.cmd config set project $ProjectId | Out-Null

if (-not $SkipSetup) {
  Run "Enabling APIs" { gcloud.cmd services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com firestore.googleapis.com secretmanager.googleapis.com routes.googleapis.com places.googleapis.com maps-backend.googleapis.com geocoding-backend.googleapis.com weather.googleapis.com }

  Write-Host "> Firestore (native mode)" -ForegroundColor Cyan
  gcloud.cmd firestore databases describe --database="(default)" 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Run "Creating Firestore" { gcloud.cmd firestore databases create --location=$Region --type=firestore-native } }

  $projectNumber = gcloud.cmd projects describe $ProjectId --format="value(projectNumber)"
  $sa = "$projectNumber-compute@developer.gserviceaccount.com"
  foreach ($role in @('roles/aiplatform.user', 'roles/datastore.user', 'roles/secretmanager.secretAccessor', 'roles/cloudbuild.builds.builder', 'roles/artifactregistry.writer', 'roles/storage.objectAdmin', 'roles/logging.logWriter')) {
    Run "Granting $role" { gcloud.cmd projects add-iam-policy-binding $ProjectId --member="serviceAccount:$sa" --role=$role --condition=None --quiet | Out-Null }
  }

  # Store the server Maps key in Secret Manager (piped via a temp file, never echoed)
  $tmp = New-TemporaryFile
  [IO.File]::WriteAllText($tmp, $serverKey)
  gcloud.cmd secrets describe maps-server-key 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Run "Updating secret" { gcloud.cmd secrets versions add maps-server-key --data-file=$tmp | Out-Null } }
  else { Run "Creating secret" { gcloud.cmd secrets create maps-server-key --data-file=$tmp | Out-Null } }
  Remove-Item $tmp
}

# Environment for Cloud Run, written to a temporary YAML file (--env-vars-file): no delimiter tricks, so values
# with commas, colons or @ survive the trip through gcloud.cmd intact.
$envMap = [ordered]@{
  GOOGLE_GENAI_USE_VERTEXAI = 'true'; GOOGLE_CLOUD_PROJECT = $ProjectId; GOOGLE_CLOUD_LOCATION = 'global'; USE_FIRESTORE = 'true'
  GEMINI_MODEL = $model; GEMINI_FALLBACK_MODELS = $fallback; MAPS_BROWSER_KEY = $browserKey; MAP_ID = $mapId
}
# Firebase web config for Google sign-in (public by design; served to the browser through /api/config)
foreach ($k in 'FIREBASE_API_KEY','FIREBASE_AUTH_DOMAIN','FIREBASE_APP_ID','FIREBASE_PROJECT_ID') { if ($envVars[$k]) { $envMap[$k] = $envVars[$k] } }
$envFile = Join-Path $env:TEMP "floodsafe-env-$PID.yaml"
$yaml = ($envMap.GetEnumerator() | ForEach-Object { "{0}: '{1}'" -f $_.Key, ($_.Value -replace "'", "''") }) -join "`n"
[IO.File]::WriteAllText($envFile, $yaml + "`n")
try {
  Run "Building & deploying to Cloud Run (3-6 min)" {
    gcloud.cmd run deploy $Service --source . --region $Region --allow-unauthenticated --memory 512Mi --max-instances 3 --set-secrets "MAPS_SERVER_KEY=maps-server-key:latest" --env-vars-file $envFile --quiet
  }
} finally { Remove-Item $envFile -ErrorAction SilentlyContinue }
$url = gcloud.cmd run services describe $Service --region $Region --format="value(status.url)"
Write-Host "Deployed: $url" -ForegroundColor Green
Write-Host "If the map is blank, add $url/* to the browser key's HTTP referrer list."
