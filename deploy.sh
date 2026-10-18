#!/usr/bin/env bash
# Deploy FloodSafe HK to Cloud Run (Hong Kong region) with Firestore + Vertex AI Gemini.
# Usage:
#   export PROJECT_ID=your-project
#   export MAPS_SERVER_KEY=...   # restricted to Routes API + Places API (New) + Geocoding API
#   export MAPS_BROWSER_KEY=...  # restricted to Maps JavaScript API + Places API (New), HTTP referrer = your run.app URL
#   ./deploy.sh
set -euo pipefail
# Pick up keys from the local .env if they aren't already exported
if [ -f .env ]; then
  while IFS='=' read -r k v; do
    case "$k" in MAPS_SERVER_KEY|MAPS_BROWSER_KEY|MAP_ID|GEMINI_MODEL|GEMINI_FALLBACK_MODELS)
      [ -z "${!k:-}" ] && export "$k=$v";; esac
  done < <(grep -E '^[A-Z_]+=' .env)
fi
: "${PROJECT_ID:?set PROJECT_ID}"
: "${MAPS_SERVER_KEY:?set MAPS_SERVER_KEY}"
MAPS_BROWSER_KEY="${MAPS_BROWSER_KEY:-$MAPS_SERVER_KEY}"
REGION="${REGION:-asia-east2}"          # asia-east2 = Hong Kong
SERVICE="${SERVICE:-floodsafe-hk}"
MODEL="${GEMINI_MODEL:-gemini-3.5-flash}"
MAP_ID="${MAP_ID:-DEMO_MAP_ID}"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "▶ Enabling APIs…"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com firestore.googleapis.com routes.googleapis.com places.googleapis.com \
  maps-backend.googleapis.com geocoding-backend.googleapis.com weather.googleapis.com secretmanager.googleapis.com

echo "▶ Firestore (native mode)…"
gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 || \
  gcloud firestore databases create --location="$REGION" --type=firestore-native

echo "▶ Granting the Cloud Run service account Vertex AI + Firestore access…"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for ROLE in roles/aiplatform.user roles/datastore.user roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="$ROLE" --condition=None >/dev/null
done

echo "▶ Storing the server Maps key in Secret Manager…"
if gcloud secrets describe maps-server-key >/dev/null 2>&1; then
  printf '%s' "$MAPS_SERVER_KEY" | gcloud secrets versions add maps-server-key --data-file=- >/dev/null
else
  printf '%s' "$MAPS_SERVER_KEY" | gcloud secrets create maps-server-key --data-file=- >/dev/null
fi

echo "▶ Building & deploying to Cloud Run…"
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --memory 512Mi --max-instances 3 \
  --set-secrets "MAPS_SERVER_KEY=maps-server-key:latest" \
  --set-env-vars "^@^GOOGLE_GENAI_USE_VERTEXAI=true@GOOGLE_CLOUD_PROJECT=$PROJECT_ID@GOOGLE_CLOUD_LOCATION=global@USE_FIRESTORE=true@GEMINI_MODEL=$MODEL@GEMINI_FALLBACK_MODELS=${GEMINI_FALLBACK_MODELS:-gemini-3.5-flash-lite,gemini-flash-latest}@MAPS_BROWSER_KEY=$MAPS_BROWSER_KEY@MAP_ID=$MAP_ID"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo "✅ Deployed: $URL"
echo "   Add ${URL}/* to the browser key's HTTP referrer restrictions."
