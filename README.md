# TitanUp V2 — Edge AI Agent Orchestrator

**Google Cloud Rapid Agent Hackathon Submission**
Built by [TitanU AI / JuJu Labs](https://titanuai.com)

---

Five fully autonomous Edge AI Agents powered by Gemini 2.0 Flash and Model Context Protocol (MCP). Each agent runs a real tool-use loop against live infrastructure — no mocks, no placeholders, no demos.

---

## Agents

### Track 1 — Dynatrace Autonomous SRE Agent
Connects to a live Dynatrace environment via MCP SSE. Pulls active problems, correlates infrastructure logs with DQL queries, cross-references memory and CPU metric series, classifies root cause, and autonomously triggers safe rollback or memory-clearing events. Falls back to direct Dynatrace REST API if MCP SSE is unavailable.

### Track 2 — Elastic Telemetry Detective
Runs real-time distributed pattern-matching across multiple named edge clusters using Elasticsearch Cross-Cluster Search. Detects sequence gaps, checksum mismatches, NULL injection, field type corruption, and replay attacks using IQR-based statistical outlier detection. Writes audit reports to a dedicated index and reindexes corrupted document slices into quarantine.

### Track 3 — MongoDB Sharding & Evolution Agent
Monitors sharded MongoDB collections under heavy JSON vector write load. Detects shard hotspots (>40% chunk concentration), slow operation patterns, COLLSCAN queries, and zero-use redundant indexes. Generates zero-downtime remediations: hidden index creation, additive `$jsonSchema` validator evolution, and safe index drops with dual-confirmation.

### Track 4 — Multi-Track Data Integrator (Fivetran + Arize Phoenix)
Monitors all Fivetran pipeline connectors for volume anomalies and schema drift. Translates every sync record into an Arize Phoenix execution trace. Scores LLM distribution drift via PSI (Population Stability Index). Auto-creates drift monitors and pauses anomalous connectors when PSI exceeds critical threshold.

### Track 5 — Security Compliance Agent (GitLab MCP)
Intercepts all open merge requests via GitLab MCP. Runs a local SAST scan against unified diffs using 15 CWE-mapped secret patterns and 8 vulnerability patterns (SQL injection, eval injection, command injection, path traversal, prototype pollution, insecure randomness, CORS wildcard, hardcoded IPs). Creates confidential remediation issues assigned to the MR author, adds inline diff comments at the exact file and line, and blocks critical MRs from merging.

---

## Stack

| Layer | Technology |
|---|---|
| LLM | Gemini 2.0 Flash (`gemini-2.0-flash`) |
| Agent Framework | Google Generative AI SDK — native function calling loop |
| Tool Protocol | Model Context Protocol (MCP) SDK v1.10+ |
| MCP Transports | SSE (Dynatrace), stdio (MongoDB, GitLab) |
| Runtime | Node.js 20+ / TypeScript 5.5 |
| Deployment | Google Cloud Run Jobs |
| Direct APIs | Dynatrace REST v2, Elasticsearch REST, Fivetran v1, Arize v1, GitLab v4 |

---

## Project Structure

```
TitanUp_V2/
├── TitanUp_V2.ts          # Complete orchestration engine — all 5 agents
├── package.json
├── tsconfig.json
├── Dockerfile
├── deploy-cloudrun.sh     # One-command GCP Cloud Run deploy
├── .env.example           # Every required environment variable
├── .gitignore
└── DEPLOY.md              # Full deployment guide
```

---

## Quickstart

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Fill every value — see DEPLOY.md for where to find each credential
```

### 3. Run

```bash
# Load environment
export $(grep -v '^#' .env | xargs)

# All 5 agents, sequential
npm run dev

# All 5 agents, parallel
npm run dev:parallel

# Single agent
npm run dev:track1   # Dynatrace SRE
npm run dev:track2   # Elastic Detective
npm run dev:track3   # MongoDB Evolution
npm run dev:track4   # Fivetran + Arize
npm run dev:track5   # GitLab Security
```

### 4. Deploy to Google Cloud Run

```bash
chmod +x deploy-cloudrun.sh
GCP_PROJECT_ID=your-project-id GCP_REGION=us-central1 ./deploy-cloudrun.sh

# Execute
gcloud run jobs execute titanup-v2-job --region us-central1 --wait
```

---

## Required Environment Variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio API key |
| `DYNATRACE_TENANT_URL` | `https://YOURTENANTID.live.dynatrace.com` |
| `DYNATRACE_API_TOKEN` | Scopes: problems.read, logs.read, metrics.read, events.ingest, entities.read |
| `ELASTIC_URL` | Elasticsearch cluster endpoint |
| `ELASTIC_API_KEY` | Base64-encoded Elastic API key |
| `MONGODB_URI` | MongoDB connection string |
| `MONGODB_DB` | Target database name |
| `FIVETRAN_API_KEY` | Fivetran API key |
| `FIVETRAN_API_SECRET` | Fivetran API secret |
| `ARIZE_API_KEY` | Arize Phoenix API key |
| `ARIZE_SPACE_ID` | Arize space identifier |
| `ARIZE_MODEL_ID` | Model name to track drift for |
| `GITLAB_URL` | GitLab instance URL |
| `GITLAB_TOKEN` | Personal access token (scopes: api, read_repository, write_repository) |
| `GITLAB_PROJECT_ID` | Numeric project ID |

Full setup instructions for every variable: [DEPLOY.md](./DEPLOY.md)

---

## CLI Flags

```bash
tsx TitanUp_V2.ts [flags]

--parallel              Run all selected agents concurrently
--tracks=1,3,5          Run only specified track numbers
--output=results.json   Write JSON results to this file (default: titan-results-<ts>.json)
--webhook=https://...   POST full results payload to this URL on completion
```

---

## Output

Every run produces a structured JSON results file:

```json
{
  "orchestrationId": "uuid",
  "timestamp": "ISO8601",
  "model": "gemini-2.0-flash",
  "results": [
    {
      "agentName": "Dynatrace Autonomous SRE Agent",
      "track": 1,
      "success": true,
      "iterations": 14,
      "findings": [
        {
          "severity": "critical",
          "category": "dt_problem",
          "message": "...",
          "evidence": {},
          "timestamp": "ISO8601"
        }
      ],
      "remediations": [
        {
          "type": "deployment_rollback",
          "description": "...",
          "automated": true,
          "result": {},
          "timestamp": "ISO8601"
        }
      ],
      "elapsedMs": 12400
    }
  ]
}
```

---

## How the Agent Loop Works

Each agent follows the same architecture:

```
Gemini function-calling loop
        │
        ▼
  Tool call declared
        │
        ▼
  MCP dispatch (SSE / stdio)
  or direct REST API call
        │
        ▼
  Real infrastructure response
        │
        ▼
  Result fed back to Gemini
        │
        ▼
  Next reasoning step
        │
        ▼
  Loop until no more function calls
  (Gemini emits final text → agent terminates)
```

No LangChain. No agent framework wrapper. Native Gemini function calling with MCP tool dispatch and direct API fallbacks.

---

## Security Note

The `.env` file contains live credentials. It is excluded from git via `.gitignore`. Never commit it. For production Cloud Run deployments, use Google Secret Manager and reference secrets via `--set-secrets` instead of `--set-env-vars`.

---

Built with Gemini · Google Cloud · MCP · TitanU AI
