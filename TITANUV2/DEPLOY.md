# TitanUp V2 — Deployment Guide

## File Structure

```
TitanUp_V2/
├── TitanUp_V2.ts          ← The entire orchestration engine
├── package.json
├── tsconfig.json
├── Dockerfile
├── deploy-cloudrun.sh     ← GCP Cloud Run one-command deploy
├── .env.example           ← Copy → .env, fill every value
└── .gitignore
```

---

## Step 0 — Prerequisites

Install these once on your machine:

```bash
# Node 20+
node --version   # must be >= 20.0.0

# If you need to upgrade:
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 20
fnm use 20

# Docker (for Cloud Run deploy)
docker --version

# Google Cloud CLI (for Cloud Run deploy)
# https://cloud.google.com/sdk/docs/install
gcloud --version
```

---

## Step 1 — Install Dependencies

```bash
cd TitanUp_V2
npm install
```

This installs:
- `@google/generative-ai` — Gemini SDK
- `@modelcontextprotocol/sdk` — MCP client
- `tsx` — run TypeScript directly without a build step
- `typescript` + `@types/node` — type checking

---

## Step 2 — Configure Environment

```bash
cp .env.example .env
```

Open `.env` and fill every value. Variable-by-variable guide:

### GEMINI_API_KEY
1. Go to https://aistudio.google.com/app/apikey
2. Create key → copy → paste

### DYNATRACE_TENANT_URL + DYNATRACE_API_TOKEN
1. Log into your Dynatrace environment
2. Tenant URL is the browser URL up to `.dynatrace.com`
3. Settings → Access Tokens → Generate Token
4. Required scopes: `problems.read`, `logs.read`, `metrics.read`,
   `events.ingest`, `entities.read`

### ELASTIC_URL + ELASTIC_API_KEY
**Elastic Cloud:**
1. cloud.elastic.co → your deployment → Copy endpoint URL
2. Security → API Keys → Create API Key → copy the encoded value

**Self-hosted:**
```bash
# URL
ELASTIC_URL=http://localhost:9200
# Create key
curl -X POST "localhost:9200/_security/api_key" \
  -H "Content-Type: application/json" \
  -u elastic:YOURPASS \
  -d '{"name":"titanup-v2","role_descriptors":{}}'
# Use the "encoded" field from the response
```

### MONGODB_URI + MONGODB_DB
**Atlas:**
1. atlas.mongodb.com → your cluster → Connect → Drivers
2. Copy the `mongodb+srv://...` string, replace `<password>`

**Self-hosted:**
```
MONGODB_URI=mongodb://user:pass@localhost:27017
MONGODB_DB=titan_vectors
```

### FIVETRAN_API_KEY + FIVETRAN_API_SECRET
1. fivetran.com → top-right avatar → API Config
2. Copy API Key and API Secret

### ARIZE_API_KEY + ARIZE_SPACE_ID + ARIZE_MODEL_ID
1. app.arize.com → Settings → API Keys → create one
2. Settings → Space → copy Space ID
3. ARIZE_MODEL_ID = any string identifier for your model

### GITLAB_URL + GITLAB_TOKEN + GITLAB_PROJECT_ID
1. gitlab.com (or your self-hosted URL)
2. Profile → Access Tokens → create with scopes: `api`, `read_repository`, `write_repository`
3. Project ID: open your repo → Settings → General → Project ID (numeric)

---

## Step 3 — Run Locally (No Build Step)

This is the fastest way to test. Uses `tsx` to run TypeScript directly.

```bash
# Load env
export $(grep -v '^#' .env | xargs)

# Run all 5 tracks sequentially
npm run dev

# Run all 5 tracks in parallel (faster, more API calls)
npm run dev:parallel

# Run a single track
npm run dev:track1    # Dynatrace SRE
npm run dev:track2    # Elastic Detective
npm run dev:track3    # MongoDB Evolution
npm run dev:track4    # Fivetran + Arize
npm run dev:track5    # GitLab Security

# Run specific combination
tsx TitanUp_V2.ts --tracks=1,5 --parallel

# Write results to specific file
tsx TitanUp_V2.ts --parallel --output=hackathon-run-1.json

# Send results to a webhook after completion
tsx TitanUp_V2.ts --parallel --webhook=https://your-webhook.site/abc123
```

---

## Step 4 — Build (Production Binary)

```bash
npm run build
# Output: dist/TitanUp_V2.js

# Run built output
export $(grep -v '^#' .env | xargs)
npm start
npm run start:parallel
```

---

## Step 5 — Deploy to Google Cloud Run (Hackathon Target)

Cloud Run Jobs is the correct GCP product for a batch agent workload.

### One-time GCP setup

```bash
# Authenticate
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  containerregistry.googleapis.com \
  secretmanager.googleapis.com

# Create a service account for the job
gcloud iam service-accounts create titanup-sa \
  --display-name="TitanUp V2 Service Account"

# Grant it permission to write logs
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:titanup-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/logging.logWriter"

# Authenticate Docker to GCR
gcloud auth configure-docker
```

### Deploy

```bash
chmod +x deploy-cloudrun.sh
GCP_PROJECT_ID=your-project-id GCP_REGION=us-central1 ./deploy-cloudrun.sh
```

### Execute the job

```bash
# Run all tracks
gcloud run jobs execute titanup-v2-job \
  --region us-central1 \
  --wait

# View logs
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="titanup-v2-job"' \
  --limit 200 \
  --format "value(textPayload)"
```

---

## Step 6 — Run on a Schedule (Cron)

```bash
# Every 30 minutes
gcloud scheduler jobs create http titanup-v2-schedule \
  --location us-central1 \
  --schedule "*/30 * * * *" \
  --uri "https://us-central1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/YOUR_PROJECT_ID/jobs/titanup-v2-job:run" \
  --http-method POST \
  --oauth-service-account-email titanup-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

---

## Troubleshooting

### "Missing env: X"
You have an unfilled value in `.env`. Check every variable against `.env.example`.

### MCP stdio server not found
The MongoDB and GitLab agents use `npx -y` to auto-install MCP servers on first run.
If your network blocks npmjs.com, pre-install manually:
```bash
npm install -g @modelcontextprotocol/server-mongodb
npm install -g @modelcontextprotocol/server-gitlab
```

### Dynatrace MCP SSE 404
If your Dynatrace plan doesn't include the MCP SSE endpoint, the agent automatically
falls back to direct REST API calls. You will see:
`[Track 1] Dynatrace MCP SSE unavailable — using direct API dispatch`
This is expected behavior. The agent works either way.

### Gemini 429 rate limit
Add `GEMINI_MODEL=gemini-2.0-flash-lite` to `.env` for a higher rate limit tier,
or run tracks sequentially (remove `--parallel`) to reduce concurrent API calls.

### Cloud Run job timeout
Default task timeout is 3600s (1 hour). If your clusters are large, increase it:
```bash
gcloud run jobs update titanup-v2-job \
  --task-timeout=7200 \
  --region us-central1
```

### Results file
Every run writes a `titan-results-<timestamp>.json` to the working directory
(or Cloud Run's ephemeral filesystem). Pass `--output=path.json` to control the name.
Mount a GCS bucket if you need persistence across Cloud Run executions.

---

## Quick Reference

| Command | What it does |
|---|---|
| `npm run dev` | Run all 5 tracks sequentially, no build |
| `npm run dev:parallel` | Run all 5 tracks in parallel, no build |
| `npm run dev:track5` | Run only Track 5 (GitLab Security) |
| `npm run build` | Compile TypeScript → dist/ |
| `npm start` | Run compiled output, all tracks |
| `./deploy-cloudrun.sh` | Build, push, deploy to GCP Cloud Run Job |
