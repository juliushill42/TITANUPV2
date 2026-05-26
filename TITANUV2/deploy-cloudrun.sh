#!/usr/bin/env bash
# deploy-cloudrun.sh
# Deploys TitanUp_V2 to Google Cloud Run (Jobs) — hackathon target
# Usage: ./deploy-cloudrun.sh
# Prereqs: gcloud CLI authenticated, Docker installed, .env filled

set -euo pipefail

# ── CONFIG ───────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
IMAGE_NAME="titanup-v2"
REPO="gcr.io/${PROJECT_ID}/${IMAGE_NAME}"
JOB_NAME="titanup-v2-job"

echo "▶ Building Docker image..."
docker build -t "${REPO}:latest" .

echo "▶ Pushing to GCR..."
docker push "${REPO}:latest"

echo "▶ Loading .env for secret creation..."
# Convert .env into --set-env-vars string (excludes comments and blank lines)
ENV_VARS=$(grep -v '^\s*#' .env | grep -v '^\s*$' | tr '\n' ',' | sed 's/,$//')

echo "▶ Creating or updating Cloud Run Job..."
gcloud run jobs create "${JOB_NAME}" \
  --image "${REPO}:latest" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --set-env-vars "${ENV_VARS}" \
  --args="--parallel" \
  --task-timeout=3600 \
  --max-retries=1 \
  --parallelism=1 \
  --service-account "titanup-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
  2>/dev/null || \
gcloud run jobs update "${JOB_NAME}" \
  --image "${REPO}:latest" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --set-env-vars "${ENV_VARS}" \
  --args="--parallel"

echo ""
echo "✓ Deployed: ${JOB_NAME} in ${REGION}"
echo ""
echo "Run it now:"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
echo ""
echo "Run a single track (e.g. Track 5):"
echo "  gcloud run jobs update ${JOB_NAME} --args='--tracks=5' --region ${REGION}"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
