/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  TitanUp_V2.ts — Google Cloud Rapid Agent Hackathon                    ║
 * ║  TitanU AI / JuJu Labs                                                 ║
 * ║                                                                         ║
 * ║  Track 1 — Dynatrace Autonomous SRE Agent                              ║
 * ║  Track 2 — Elastic Telemetry Detective                                 ║
 * ║  Track 3 — MongoDB Advanced Sharding & Evolution Agent                 ║
 * ║  Track 4 — Multi-Track Data Integrator (Fivetran + Arize Phoenix)      ║
 * ║  Track 5 — Security Compliance Agent (GitLab MCP)                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Runtime: Node 20+ / Bun 1.1+
 * Usage:
 *   npx ts-node TitanUp_V2.ts [--parallel] [--tracks=1,2,3,4,5] \
 *                              [--output=results.json] [--webhook=https://...]
 */

import {
  GoogleGenerativeAI,
  type Tool,
  type FunctionDeclaration,
  type Part,
} from "@google/generative-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";

// ─────────────────────────────────────────────────────────────────────────────
// § ENVIRONMENT VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENV = [
  "GEMINI_API_KEY",
  "DYNATRACE_TENANT_URL",
  "DYNATRACE_API_TOKEN",
  "ELASTIC_URL",
  "ELASTIC_API_KEY",
  "MONGODB_URI",
  "MONGODB_DB",
  "FIVETRAN_API_KEY",
  "FIVETRAN_API_SECRET",
  "ARIZE_API_KEY",
  "ARIZE_SPACE_ID",
  "ARIZE_MODEL_ID",
  "GITLAB_URL",
  "GITLAB_TOKEN",
  "GITLAB_PROJECT_ID",
] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`[TitanUp] Missing env: ${key}`);
}

const ENV = {
  GEMINI_API_KEY:        process.env.GEMINI_API_KEY!,
  GEMINI_MODEL:          process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
  DYNATRACE_TENANT_URL:  process.env.DYNATRACE_TENANT_URL!,
  DYNATRACE_API_TOKEN:   process.env.DYNATRACE_API_TOKEN!,
  ELASTIC_URL:           process.env.ELASTIC_URL!,
  ELASTIC_API_KEY:       process.env.ELASTIC_API_KEY!,
  MONGODB_URI:           process.env.MONGODB_URI!,
  MONGODB_DB:            process.env.MONGODB_DB!,
  FIVETRAN_API_KEY:      process.env.FIVETRAN_API_KEY!,
  FIVETRAN_API_SECRET:   process.env.FIVETRAN_API_SECRET!,
  ARIZE_API_KEY:         process.env.ARIZE_API_KEY!,
  ARIZE_SPACE_ID:        process.env.ARIZE_SPACE_ID!,
  ARIZE_MODEL_ID:        process.env.ARIZE_MODEL_ID!,
  GITLAB_URL:            process.env.GITLAB_URL!,
  GITLAB_TOKEN:          process.env.GITLAB_TOKEN!,
  GITLAB_PROJECT_ID:     process.env.GITLAB_PROJECT_ID!,
};

// ─────────────────────────────────────────────────────────────────────────────
// § SHARED TYPES
// ─────────────────────────────────────────────────────────────────────────────

type Severity = "critical" | "high" | "medium" | "low" | "info";

interface Finding {
  severity: Severity;
  category: string;
  message: string;
  evidence: unknown;
  timestamp: string;
}

interface Remediation {
  type: string;
  description: string;
  automated: boolean;
  result?: unknown;
  timestamp: string;
}

interface AgentAction {
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
}

interface AgentResult {
  agentName: string;
  track: number;
  success: boolean;
  iterations: number;
  actions: AgentAction[];
  findings: Finding[];
  remediations: Remediation[];
  elapsedMs: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// § GEMINI FACTORY
// ─────────────────────────────────────────────────────────────────────────────

const gemini = new GoogleGenerativeAI(ENV.GEMINI_API_KEY);

function buildModel(systemPrompt: string, tools: FunctionDeclaration[]) {
  return gemini.getGenerativeModel({
    model: ENV.GEMINI_MODEL,
    systemInstruction: systemPrompt,
    tools: tools.length > 0 ? ([{ functionDeclarations: tools }] as Tool[]) : undefined,
    generationConfig: { temperature: 0.1, topP: 0.95, maxOutputTokens: 8192 },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// § MCP CLIENT FACTORIES
// ─────────────────────────────────────────────────────────────────────────────

async function mcpSSE(
  url: string,
  headers: Record<string, string> = {}
): Promise<Client> {
  const transport = new SSEClientTransport(new URL(url), { headers });
  const c = new Client(
    { name: "titanu-edge-agent", version: "2.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );
  await c.connect(transport);
  return c;
}

async function mcpStdio(
  command: string,
  args: string[],
  env: Record<string, string> = {}
): Promise<Client> {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const c = new Client(
    { name: "titanu-edge-agent", version: "2.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );
  await c.connect(transport);
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// § AGENT BASE CLASS
// ─────────────────────────────────────────────────────────────────────────────

abstract class TitanEdgeAgent extends EventEmitter {
  protected mcp: Client | null = null;
  protected actions: AgentAction[] = [];
  protected findings: Finding[] = [];
  protected remediations: Remediation[] = [];

  constructor(
    protected readonly name: string,
    protected readonly track: number,
    protected readonly maxIterations = 20,
    protected readonly iterDelayMs = 500
  ) { super(); }

  abstract connect(): Promise<void>;
  abstract run(): Promise<AgentResult>;

  protected async callMCP(tool: string, input: Record<string, unknown>): Promise<unknown> {
    if (!this.mcp) throw new Error("MCP client not connected");
    const r = await this.mcp.callTool({ name: tool, arguments: input });
    return r.content;
  }

  protected record(tool: string, input: Record<string, unknown>, output: unknown, ms: number) {
    this.actions.push({ timestamp: new Date().toISOString(), tool, input, output, durationMs: ms });
  }

  protected finding(f: Omit<Finding, "timestamp">) {
    const fin = { ...f, timestamp: new Date().toISOString() };
    this.findings.push(fin);
    this.emit("finding", fin);
  }

  protected remediation(r: Omit<Remediation, "timestamp">) {
    const rem = { ...r, timestamp: new Date().toISOString() };
    this.remediations.push(rem);
    this.emit("remediation", rem);
  }

  protected result(success: boolean, elapsed: number, error?: string): AgentResult {
    return {
      agentName: this.name, track: this.track, success,
      iterations: this.actions.length, actions: this.actions,
      findings: this.findings, remediations: this.remediations,
      elapsedMs: elapsed, error,
    };
  }

  async disconnect(): Promise<void> {
    if (this.mcp) { await this.mcp.close(); this.mcp = null; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  TRACK 1 — DYNATRACE AUTONOMOUS SRE AGENT
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

const DT_FUNCTIONS: FunctionDeclaration[] = [
  {
    name: "list_active_problems",
    description: "Fetch all open Dynatrace problems ordered by severity with impacted entity IDs",
    parameters: {
      type: "object",
      properties: {
        severityFilter: { type: "string", description: "AVAILABILITY|ERROR|PERFORMANCE|RESOURCE_CONTENTION" },
        from: { type: "string", description: "Relative (-30m) or ISO8601" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "query_logs",
    description: "Execute a DQL log query for a specific entity to retrieve correlated log lines",
    parameters: {
      type: "object",
      properties: {
        dqlQuery: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        limit: { type: "number" },
      },
      required: ["dqlQuery"],
    },
  },
  {
    name: "get_metric_series",
    description: "Fetch a Dynatrace metric time series via metric selector",
    parameters: {
      type: "object",
      properties: {
        metricSelector: { type: "string" },
        resolution: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        entitySelector: { type: "string" },
      },
      required: ["metricSelector"],
    },
  },
  {
    name: "push_deployment_rollback_event",
    description: "Emit a CUSTOM_DEPLOYMENT event to Dynatrace marking an autonomous rollback",
    parameters: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        deploymentName: { type: "string" },
        rollbackToVersion: { type: "string" },
        remediationReason: { type: "string" },
      },
      required: ["entityId", "deploymentName", "rollbackToVersion", "remediationReason"],
    },
  },
  {
    name: "push_memory_clear_event",
    description: "Emit a CUSTOM_ANNOTATION event to an entity to record that a memory-clearing routine was triggered",
    parameters: {
      type: "object",
      properties: {
        entitySelector: { type: "string" },
        heapBeforeMb: { type: "number" },
        gcCycles: { type: "number" },
        triggered_by: { type: "string" },
      },
      required: ["entitySelector"],
    },
  },
  {
    name: "get_entity_metadata",
    description: "Resolve entity metadata (host name, process group, tags) by entity ID",
    parameters: {
      type: "object",
      properties: { entityId: { type: "string" } },
      required: ["entityId"],
    },
  },
];

class DynatraceAutonomousSREAgent extends TitanEdgeAgent {
  private readonly base: string;
  private readonly token: string;
  private chat: ReturnType<ReturnType<typeof buildModel>["startChat"]> | null = null;

  constructor() {
    super("Dynatrace Autonomous SRE Agent", 1, 28, 1000);
    this.base = ENV.DYNATRACE_TENANT_URL.replace(/\/$/, "");
    this.token = ENV.DYNATRACE_API_TOKEN;
  }

  async connect(): Promise<void> {
    // Primary: Dynatrace-provided MCP SSE endpoint
    // Falls back to direct API dispatch if MCP server not available
    try {
      this.mcp = await mcpSSE(
        `${this.base}/api/mcp/v1/sse`,
        { Authorization: `Api-Token ${this.token}` }
      );
    } catch {
      console.warn("[Track 1] Dynatrace MCP SSE unavailable — using direct API dispatch");
    }
    const m = buildModel(
      `You are a battle-hardened Principal SRE operating a Dynatrace-instrumented cloud platform.

EXECUTION LOOP:
1. list_active_problems with from=-30m. Rank findings: AVAILABILITY > ERROR > PERFORMANCE.
2. For each critical/high problem, resolve entity metadata via get_entity_metadata then 
   query_logs with a targeted DQL: filter dt.entity.id="<entityId>" | filter loglevel="ERROR" 
   | sort timestamp desc | limit 50
3. Cross-reference with get_metric_series for the affected entity:
   - Memory pressure: builtin:host.mem.usage, builtin:process.mem.rss
   - GC storms: builtin:tech.jvm.garbageCollection.suspensionTime
   - CPU saturation: builtin:host.cpu.usage
4. Root-cause classification matrix:
   - heap RSS > 90% + GC suspension > 2s → MEMORY_PRESSURE → push_memory_clear_event + push_deployment_rollback_event
   - ERROR log spike > 50/min + recent deployment → DEPLOYMENT_REGRESSION → push_deployment_rollback_event
   - CPU > 95% sustained 10m + no deployment → RESOURCE_SATURATION → push_memory_clear_event (clear thread pools)
5. After each remediation, re-query the metric series 1 cycle later to confirm stabilization trend.
6. Return a structured JSON incident report: { problemId, entityId, rootCause, remediations[], stabilized }.

RULES: Never fabricate entity IDs. All entity IDs must originate from list_active_problems or get_entity_metadata results.`,
      DT_FUNCTIONS
    );
    this.chat = m.startChat({ history: [] });
  }

  private async dt(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const r = await fetch(`${this.base}/api/v2${path}`, {
      method,
      headers: {
        Authorization: `Api-Token ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`DT ${method} ${path} → ${r.status}: ${await r.text()}`);
    return r.json();
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const t = Date.now();
    let out: unknown;

    switch (tool) {
      case "list_active_problems": {
        const p = new URLSearchParams({ pageSize: String(args.limit ?? 50), from: String(args.from ?? "now-30m") });
        if (args.severityFilter) p.set("problemSelector", `status("open"),severityLevel("${args.severityFilter}")`);
        out = await this.dt(`/problems?${p}`);
        const probs = (out as { problems?: Array<{ problemId: string; severityLevel: string; title: string; impactedEntities?: unknown[] }> }).problems ?? [];
        for (const p of probs) {
          if (p.severityLevel === "AVAILABILITY" || p.severityLevel === "ERROR") {
            this.finding({ severity: p.severityLevel === "AVAILABILITY" ? "critical" : "high", category: "dt_problem", message: p.title, evidence: p });
          }
        }
        break;
      }
      case "query_logs": {
        out = await this.dt("/logs/search", "POST", {
          query: args.dqlQuery, from: args.from ?? "now-15m",
          to: args.to ?? "now", limit: args.limit ?? 100,
        });
        break;
      }
      case "get_metric_series": {
        const p = new URLSearchParams({
          metricSelector: String(args.metricSelector),
          resolution: String(args.resolution ?? "1m"),
          from: String(args.from ?? "now-30m"),
          to: String(args.to ?? "now"),
        });
        if (args.entitySelector) p.set("entitySelector", String(args.entitySelector));
        out = await this.dt(`/metrics/query?${p}`);
        break;
      }
      case "push_deployment_rollback_event": {
        out = await this.dt("/events/ingest", "POST", {
          eventType: "CUSTOM_DEPLOYMENT",
          title: `[SRE-AUTO] Rollback: ${args.deploymentName}`,
          entitySelector: `entityId("${args.entityId}")`,
          properties: {
            "dt.event.deployment.name": args.deploymentName,
            "dt.event.deployment.version": args.rollbackToVersion,
            remediationAction: "ROLLBACK",
            remediationReason: args.remediationReason,
            triggeredBy: "TitanU-SRE-Agent-v2",
            autonomous: "true",
          },
        });
        this.remediation({ type: "deployment_rollback", description: `Rollback issued for ${args.deploymentName} on ${args.entityId}: ${args.remediationReason}`, automated: true, result: out });
        break;
      }
      case "push_memory_clear_event": {
        out = await this.dt("/events/ingest", "POST", {
          eventType: "CUSTOM_ANNOTATION",
          title: "[SRE-AUTO] Memory clearing routine triggered",
          entitySelector: args.entitySelector,
          properties: {
            heapBeforeMb: String(args.heapBeforeMb ?? "unknown"),
            gcCycles: String(args.gcCycles ?? "unknown"),
            triggeredBy: args.triggered_by ?? "TitanU-SRE-Agent-v2",
            action: "MEMORY_CLEAR",
          },
        });
        this.remediation({ type: "memory_clear", description: `Memory clearing routine triggered on ${args.entitySelector}`, automated: true, result: out });
        break;
      }
      case "get_entity_metadata": {
        out = await this.dt(`/entities/${encodeURIComponent(String(args.entityId))}?fields=displayName,properties,tags`);
        break;
      }
      default:
        throw new Error(`Unknown DT tool: ${tool}`);
    }

    this.record(tool, args, out, Date.now() - t);
    return out;
  }

  async run(): Promise<AgentResult> {
    const t0 = Date.now();
    if (!this.chat) await this.connect();
    try {
      let resp = await this.chat!.sendMessage(
        "BEGIN SRE_CYCLE. Enumerate active problems (last 30 min). For each critical/high: resolve entity, correlate logs, confirm via metrics, apply the correct safe remediation. After all cycles complete, emit a JSON incident summary."
      );
      for (let i = 0; i < this.maxIterations; i++) {
        const parts = resp.response.candidates?.[0]?.content?.parts ?? [];
        const fns = parts.filter((p: Part) => (p as { functionCall?: unknown }).functionCall);
        if (fns.length === 0) {
          const txt = parts.find((p: Part) => (p as { text?: string }).text);
          if ((txt as { text?: string })?.text) this.finding({ severity: "info", category: "sre_cycle_complete", message: (txt as { text: string }).text, evidence: { iter: i } });
          break;
        }
        const results: Part[] = [];
        for (const part of fns) {
          const fc = (part as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
          try {
            const r = await this.dispatch(fc.name, fc.args);
            results.push({ functionResponse: { name: fc.name, response: { content: JSON.stringify(r) } } } as Part);
          } catch (e) {
            results.push({ functionResponse: { name: fc.name, response: { content: `Error: ${(e as Error).message}` } } } as Part);
          }
        }
        resp = await this.chat!.sendMessage(results);
        await sleep(this.iterDelayMs);
      }
      return this.result(true, Date.now() - t0);
    } catch (e) {
      return this.result(false, Date.now() - t0, (e as Error).message);
    } finally { await this.disconnect(); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  TRACK 2 — ELASTIC TELEMETRY DETECTIVE
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

const ES_FUNCTIONS: FunctionDeclaration[] = [
  {
    name: "kql_search",
    description: "Execute a KQL query against an Elasticsearch index pattern and return hits with scores",
    parameters: {
      type: "object",
      properties: {
        index: { type: "string" },
        kql: { type: "string" },
        size: { type: "number" },
        sortField: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        source: { type: "array", items: { type: "string" } },
      },
      required: ["index", "kql"],
    },
  },
  {
    name: "aggregate",
    description: "Run an Elasticsearch aggregation pipeline for statistical anomaly detection",
    parameters: {
      type: "object",
      properties: {
        index: { type: "string" },
        timeField: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        aggs: { type: "object", description: "Raw ES aggregation DSL" },
      },
      required: ["index", "aggs"],
    },
  },
  {
    name: "field_statistics",
    description: "Compute extended_stats and percentiles on a numeric field to detect IQR-based outliers",
    parameters: {
      type: "object",
      properties: {
        index: { type: "string" },
        field: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["index", "field"],
    },
  },
  {
    name: "cross_cluster_kql",
    description: "Search across multiple named remote clusters simultaneously using CCS syntax",
    parameters: {
      type: "object",
      properties: {
        clusters: { type: "array", items: { type: "string" } },
        indexPattern: { type: "string" },
        kql: { type: "string" },
        size: { type: "number" },
      },
      required: ["clusters", "indexPattern", "kql"],
    },
  },
  {
    name: "index_corruption_report",
    description: "Write a corruption detection report document to the titan-corruption-audit index",
    parameters: {
      type: "object",
      properties: {
        clusterNode: { type: "string" },
        affectedIndex: { type: "string" },
        corruptionType: { type: "string", description: "SEQUENCE_GAP|CHECKSUM_MISMATCH|FIELD_TYPE_CORRUPTION|NULL_INJECTION|REPLAY_DETECTED" },
        affectedDocEstimate: { type: "number" },
        sampleDocIds: { type: "array", items: { type: "string" } },
        pctAffected: { type: "number" },
        severity: { type: "string" },
        remediationHint: { type: "string" },
      },
      required: ["clusterNode", "affectedIndex", "corruptionType", "severity"],
    },
  },
  {
    name: "reindex_corrupted_slice",
    description: "Trigger an Elasticsearch reindex operation from corrupted source to a clean destination index",
    parameters: {
      type: "object",
      properties: {
        sourceIndex: { type: "string" },
        destIndex: { type: "string" },
        query: { type: "object", description: "ES query to select only corrupted documents" },
        maxDocs: { type: "number" },
      },
      required: ["sourceIndex", "destIndex", "query"],
    },
  },
];

class ElasticTelemetryDetective extends TitanEdgeAgent {
  private chat: ReturnType<ReturnType<typeof buildModel>["startChat"]> | null = null;

  constructor() { super("Elastic Telemetry Detective", 2, 28, 800); }

  async connect(): Promise<void> {
    const m = buildModel(
      `You are a Principal Data Integrity Engineer specialized in distributed telemetry forensics 
across a multi-cluster Elasticsearch edge deployment.

EXECUTION LOOP:
1. cross_cluster_kql across clusters ["edge-us-east","edge-us-west","edge-eu-west","edge-ap-southeast"] 
   on "telemetry-*" with kql="*" (last 60 minutes), size=0 to get doc counts per cluster.
2. field_statistics on "telemetry-*" for fields: byte_count, sequence_id, event_duration_ms, checksum_hash_length.
3. Corruption pattern detection via aggregate:
   a. Sequence gaps: date_histogram on @timestamp with 1m buckets + max/min sequence_id per bucket.
      Flag buckets where max(sequence_id) - min(sequence_id) != doc_count - 1.
   b. Checksum anomalies: terms agg on checksum_hash → missing bucket size > 0 = NULL_INJECTION.
   c. Field type drift: kql_search with kql="NOT _exists_:checksum_hash AND byte_count:>0" → CHECKSUM_MISMATCH.
   d. Replay: kql_search with kql="sequence_id:[0 TO 100]" sorted by @timestamp desc → check for 
      sequence IDs appearing in multiple time buckets.
4. Classify each anomaly: SEQUENCE_GAP | CHECKSUM_MISMATCH | FIELD_TYPE_CORRUPTION | NULL_INJECTION | REPLAY_DETECTED.
5. For anomalies affecting > 0.5% of docs: index_corruption_report with full evidence.
6. For CHECKSUM_MISMATCH or REPLAY_DETECTED severity=critical: call reindex_corrupted_slice 
   to isolate tainted documents into "titan-quarantine-<date>" index.
7. Return a cross-cluster corruption surface map: { cluster, index, type, docCount, pct, remediation }.

RULES: Never guess doc IDs — all IDs must come from actual kql_search results.`,
      ES_FUNCTIONS
    );
    this.chat = m.startChat({ history: [] });
  }

  private kqlToES(kql: string): Record<string, unknown> {
    if (!kql || kql === "*") return { match_all: {} };
    return { query_string: { query: kql, default_operator: "AND" } };
  }

  private async es(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const r = await fetch(`${ENV.ELASTIC_URL.replace(/\/$/, "")}${path}`, {
      method,
      headers: { Authorization: `ApiKey ${ENV.ELASTIC_API_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`ES ${method} ${path} → ${r.status}: ${await r.text()}`);
    return r.json();
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const t = Date.now();
    let out: unknown;

    switch (tool) {
      case "kql_search": {
        const body: Record<string, unknown> = {
          query: this.kqlToES(String(args.kql)),
          size: Number(args.size ?? 20),
          sort: [{ [String(args.sortField ?? "@timestamp")]: { order: "desc" } }],
        };
        if (args.from || args.to) body.query = { bool: { must: [body.query, { range: { "@timestamp": { gte: args.from ?? "now-1h", lte: args.to ?? "now" } } }] } };
        if (Array.isArray(args.source)) body._source = args.source;
        out = await this.es(`/${args.index}/_search`, "POST", body);
        break;
      }
      case "aggregate": {
        const body: Record<string, unknown> = { size: 0, aggs: args.aggs };
        if (args.from || args.to) body.query = { range: { [String(args.timeField ?? "@timestamp")]: { gte: args.from ?? "now-1h", lte: args.to ?? "now" } } };
        out = await this.es(`/${args.index}/_search`, "POST", body);
        break;
      }
      case "field_statistics": {
        out = await this.es(`/${args.index}/_search`, "POST", {
          size: 0,
          query: (args.from || args.to) ? { range: { "@timestamp": { gte: args.from ?? "now-1h", lte: args.to ?? "now" } } } : { match_all: {} },
          aggs: {
            ext_stats: { extended_stats: { field: args.field } },
            pctiles: { percentiles: { field: args.field, percents: [1, 5, 25, 50, 75, 95, 99] } },
          },
        });
        break;
      }
      case "cross_cluster_kql": {
        const clusters = (args.clusters as string[]).map((c) => `${c}:${args.indexPattern}`).join(",");
        out = await this.es(`/${clusters}/_search`, "POST", {
          query: this.kqlToES(String(args.kql)),
          size: Number(args.size ?? 10),
        });
        break;
      }
      case "index_corruption_report": {
        const docId = crypto.randomUUID();
        out = await this.es(`/titan-corruption-audit/_doc/${docId}`, "PUT", {
          ...args,
          "@timestamp": new Date().toISOString(),
          detectedBy: "TitanU-Elastic-Detective-v2",
        });
        this.finding({ severity: args.severity as Severity, category: `elastic_${args.corruptionType}`, message: `Silent corruption: ${args.corruptionType} on ${args.affectedIndex} @ ${args.clusterNode} (~${args.affectedDocEstimate ?? "?"} docs, ${args.pctAffected?.toFixed(2) ?? "?"}%)`, evidence: args });
        this.remediation({ type: "corruption_audit_indexed", description: `Corruption report ${docId} written to titan-corruption-audit`, automated: true, result: out });
        break;
      }
      case "reindex_corrupted_slice": {
        out = await this.es("/_reindex?wait_for_completion=false", "POST", {
          source: { index: args.sourceIndex, query: args.query, ...(args.maxDocs ? { max_docs: args.maxDocs } : {}) },
          dest: { index: `titan-quarantine-${new Date().toISOString().slice(0, 10)}`, op_type: "create" },
        });
        this.remediation({ type: "reindex_quarantine", description: `Corrupted slice from ${args.sourceIndex} reindexed to quarantine`, automated: true, result: out });
        break;
      }
      default: throw new Error(`Unknown ES tool: ${tool}`);
    }

    this.record(tool, args, out, Date.now() - t);
    return out;
  }

  async run(): Promise<AgentResult> {
    const t0 = Date.now();
    if (!this.chat) await this.connect();
    try {
      let resp = await this.chat!.sendMessage(
        "BEGIN TELEMETRY_SWEEP. Cross-cluster scan all edge nodes. Run IQR anomaly detection on all telemetry fields. Classify every corruption vector. Index audit reports. Quarantine critical taint. Return corruption surface map."
      );
      for (let i = 0; i < this.maxIterations; i++) {
        const parts = resp.response.candidates?.[0]?.content?.parts ?? [];
        const fns = parts.filter((p: Part) => (p as { functionCall?: unknown }).functionCall);
        if (fns.length === 0) {
          const txt = (parts.find((p: Part) => (p as { text?: string }).text) as { text?: string });
          if (txt?.text) this.finding({ severity: "info", category: "sweep_complete", message: txt.text, evidence: { iter: i } });
          break;
        }
        const results: Part[] = [];
        for (const part of fns) {
          const fc = (part as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
          try {
            const r = await this.dispatch(fc.name, fc.args);
            results.push({ functionResponse: { name: fc.name, response: { content: JSON.stringify(r) } } } as Part);
          } catch (e) {
            results.push({ functionResponse: { name: fc.name, response: { content: `Error: ${(e as Error).message}` } } } as Part);
          }
        }
        resp = await this.chat!.sendMessage(results);
        await sleep(this.iterDelayMs);
      }
      return this.result(true, Date.now() - t0);
    } catch (e) {
      return this.result(false, Date.now() - t0, (e as Error).message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  TRACK 3 — MONGODB ADVANCED SHARDING & EVOLUTION AGENT
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

const MONGO_FUNCTIONS: FunctionDeclaration[] = [
  {
    name: "collection_stats",
    description: "Fetch collStats for a collection: document count, avg object size, storage size, index sizes",
    parameters: {
      type: "object",
      properties: {
        db: { type: "string" },
        collection: { type: "string" },
      },
      required: ["db", "collection"],
    },
  },
  {
    name: "shard_distribution",
    description: "Return chunk count and data size per shard for a sharded collection",
    parameters: {
      type: "object",
      properties: { db: { type: "string" }, collection: { type: "string" } },
      required: ["db", "collection"],
    },
  },
  {
    name: "slow_operations",
    description: "Query system.profile for operations slower than slowMs threshold",
    parameters: {
      type: "object",
      properties: {
        db: { type: "string" },
        slowMs: { type: "number" },
        limit: { type: "number" },
        ns: { type: "string", description: "Namespace filter e.g. mydb.vectors" },
      },
      required: ["db", "slowMs"],
    },
  },
  {
    name: "index_usage_stats",
    description: "Return $indexStats for a collection to identify unused or duplicate indexes",
    parameters: {
      type: "object",
      properties: { db: { type: "string" }, collection: { type: "string" } },
      required: ["db", "collection"],
    },
  },
  {
    name: "create_hidden_index",
    description: "Create a new index with hidden:true for zero-downtime evaluation",
    parameters: {
      type: "object",
      properties: {
        db: { type: "string" },
        collection: { type: "string" },
        keySpec: { type: "object", description: "Index key specification e.g. { embedding: 1, tenant_id: 1 }" },
        options: { type: "object", description: "Index options: name, unique, sparse, expireAfterSeconds" },
      },
      required: ["db", "collection", "keySpec"],
    },
  },
  {
    name: "evolve_schema",
    description: "Apply an additive $jsonSchema validator to a collection (zero-downtime schema evolution)",
    parameters: {
      type: "object",
      properties: {
        db: { type: "string" },
        collection: { type: "string" },
        jsonSchema: { type: "object" },
        validationAction: { type: "string", enum: ["warn", "error"] },
        validationLevel: { type: "string", enum: ["off", "moderate", "strict"] },
      },
      required: ["db", "collection", "jsonSchema"],
    },
  },
  {
    name: "explain_query",
    description: "Run explain('executionStats') on a filter to detect COLLSCAN and measure document examination",
    parameters: {
      type: "object",
      properties: {
        db: { type: "string" },
        collection: { type: "string" },
        filter: { type: "object" },
        hint: { type: "object" },
      },
      required: ["db", "collection", "filter"],
    },
  },
  {
    name: "drop_zero_use_index",
    description: "Drop an index with 0 accesses since last restart after explicit confirmation it is redundant",
    parameters: {
      type: "object",
      properties: {
        db: { type: "string" },
        collection: { type: "string" },
        indexName: { type: "string" },
        reason: { type: "string" },
      },
      required: ["db", "collection", "indexName", "reason"],
    },
  },
];

class MongoDBShardingEvolutionAgent extends TitanEdgeAgent {
  private chat: ReturnType<ReturnType<typeof buildModel>["startChat"]> | null = null;

  constructor() { super("MongoDB Sharding & Evolution Agent", 3, 22, 1500); }

  async connect(): Promise<void> {
    this.mcp = await mcpStdio(
      "npx",
      ["-y", "@modelcontextprotocol/server-mongodb", ENV.MONGODB_URI],
      {}
    );
    const m = buildModel(
      `You are a Principal MongoDB Architect. You govern a sharded cluster under sustained heavy vector write load.

EXECUTION LOOP:
1. collection_stats for collections: vectors, embeddings, inference_cache, audit_log.
   Flag any collection where avgObjSize > 64KB (vector bloat) or docCount > 50M (sharding pressure).
2. shard_distribution for vectors and embeddings. Compute chunk % per shard.
   HOTSPOT THRESHOLD: any shard > 40% of total chunks. Emit hotspot finding.
3. slow_operations with slowMs=50 for db=${ENV.MONGODB_DB}. 
   Identify the top-3 slowest operation patterns by namespace and command shape.
4. index_usage_stats for vectors and embeddings.
   - accesses.ops == 0 since last restart AND index age > 24h → DROP CANDIDATE
   - Two indexes where one key set is a prefix of the other → REDUNDANCY
5. For each slow operation pattern, run explain_query on the canonical filter to classify:
   COLLSCAN (no index) | IXSCAN (index used) | FETCH (index + doc fetch)
6. Execute remediations:
   a. COLLSCAN → create_hidden_index with the compound key matching the slow query filter.
      Index options: { hidden: true, name: "titan_auto_<collection>_<timestamp>", background: true }
   b. New required vector field missing from schema → evolve_schema with $jsonSchema adding the 
      field as optional (validationAction: warn, validationLevel: moderate) first.
   c. Confirmed zero-use redundant index (verify with 2 index_usage_stats calls 60s apart) → 
      drop_zero_use_index with explicit reason.
7. Output a JSON shard health scorecard:
   { shardImbalancePct, hotspotRisk: bool, indexEfficiencyScore: 0-100, schemaCompliance: pct,
     collectionHealthMap: [{ name, docCount, avgObjKb, worstSlowOpMs, action }],
     top3Recommendations: [{ action, estimatedImpact }] }`,
      MONGO_FUNCTIONS
    );
    this.chat = m.startChat({ history: [] });
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const t = Date.now();
    const out = await this.callMCP(tool, args);
    this.record(tool, args, out, Date.now() - t);

    if (tool === "shard_distribution") {
      const shards = (out as { shards?: Array<{ shardId: string; chunkCount: number }> }).shards ?? [];
      const total = shards.reduce((s, sh) => s + sh.chunkCount, 0);
      for (const sh of shards) {
        const pct = total > 0 ? (sh.chunkCount / total) * 100 : 0;
        if (pct > 40) this.finding({ severity: "high", category: "mongo_shard_hotspot", message: `Shard hotspot: ${sh.shardId} holds ${pct.toFixed(1)}% of chunks in ${args.db}.${args.collection}`, evidence: { ...sh, pct } });
      }
    }
    if (tool === "evolve_schema") this.remediation({ type: "schema_evolution", description: `$jsonSchema evolution applied to ${args.db}.${args.collection} (action=${args.validationAction})`, automated: true, result: out });
    if (tool === "create_hidden_index") this.remediation({ type: "hidden_index_created", description: `Hidden index created on ${args.db}.${args.collection}: ${JSON.stringify(args.keySpec)}`, automated: true, result: out });
    if (tool === "drop_zero_use_index") this.remediation({ type: "zero_use_index_dropped", description: `Dropped index ${args.indexName} on ${args.db}.${args.collection}: ${args.reason}`, automated: true, result: out });

    return out;
  }

  async run(): Promise<AgentResult> {
    const t0 = Date.now();
    if (!this.chat) await this.connect();
    try {
      let resp = await this.chat!.sendMessage(
        `BEGIN SHARD_CYCLE for database ${ENV.MONGODB_DB}. Analyze all vector collections. Detect hotspots, slow ops, index waste. Execute all required schema and index remediations. Produce the shard health scorecard JSON.`
      );
      for (let i = 0; i < this.maxIterations; i++) {
        const parts = resp.response.candidates?.[0]?.content?.parts ?? [];
        const fns = parts.filter((p: Part) => (p as { functionCall?: unknown }).functionCall);
        if (fns.length === 0) {
          const txt = (parts.find((p: Part) => (p as { text?: string }).text) as { text?: string });
          if (txt?.text) this.finding({ severity: "info", category: "shard_scorecard", message: txt.text, evidence: { iter: i } });
          break;
        }
        const results: Part[] = [];
        for (const part of fns) {
          const fc = (part as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
          try {
            const r = await this.dispatch(fc.name, fc.args);
            results.push({ functionResponse: { name: fc.name, response: { content: JSON.stringify(r) } } } as Part);
          } catch (e) {
            results.push({ functionResponse: { name: fc.name, response: { content: `Error: ${(e as Error).message}` } } } as Part);
          }
        }
        resp = await this.chat!.sendMessage(results);
        await sleep(this.iterDelayMs);
      }
      return this.result(true, Date.now() - t0);
    } catch (e) {
      return this.result(false, Date.now() - t0, (e as Error).message);
    } finally { await this.disconnect(); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  TRACK 4 — MULTI-TRACK DATA INTEGRATOR (FIVETRAN + ARIZE PHOENIX)
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

const FT_ARIZE_FUNCTIONS: FunctionDeclaration[] = [
  {
    name: "list_connectors",
    description: "List all Fivetran connectors with status, last sync time, and volume metrics",
    parameters: {
      type: "object",
      properties: {
        groupId: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "connector_sync_log",
    description: "Retrieve recent sync log entries for a Fivetran connector to assess volume trends",
    parameters: {
      type: "object",
      properties: {
        connectorId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["connectorId"],
    },
  },
  {
    name: "connector_schema",
    description: "Get the current Fivetran schema config: tables, columns, hashed/blocked status",
    parameters: {
      type: "object",
      properties: { connectorId: { type: "string" } },
      required: ["connectorId"],
    },
  },
  {
    name: "pause_connector",
    description: "Pause a Fivetran connector to halt data ingestion",
    parameters: {
      type: "object",
      properties: {
        connectorId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["connectorId", "reason"],
    },
  },
  {
    name: "log_arize_traces",
    description: "Send execution trace records to Arize Phoenix for LLM drift scoring",
    parameters: {
      type: "object",
      properties: {
        modelId: { type: "string" },
        modelVersion: { type: "string" },
        environment: { type: "string", enum: ["production", "staging", "tracing"] },
        records: {
          type: "array",
          items: {
            type: "object",
            properties: {
              predictionId: { type: "string" },
              predictionLabel: { type: "string" },
              actualLabel: { type: "string" },
              features: { type: "object" },
              tags: { type: "object" },
            },
          },
        },
      },
      required: ["modelId", "records"],
    },
  },
  {
    name: "get_drift_scores",
    description: "Retrieve PSI and KL-divergence drift scores from Arize Phoenix for a model",
    parameters: {
      type: "object",
      properties: {
        modelId: { type: "string" },
        startTime: { type: "string" },
        endTime: { type: "string" },
        metricTypes: { type: "array", items: { type: "string" } },
      },
      required: ["modelId"],
    },
  },
  {
    name: "create_arize_monitor",
    description: "Create a drift monitor/alert rule in Arize Phoenix",
    parameters: {
      type: "object",
      properties: {
        modelId: { type: "string" },
        monitorName: { type: "string" },
        metric: { type: "string" },
        threshold: { type: "number" },
        operator: { type: "string", enum: ["greater_than", "less_than"] },
        channels: { type: "array", items: { type: "string" } },
      },
      required: ["modelId", "monitorName", "metric", "threshold"],
    },
  },
];

class FivetranArizeIntegratorAgent extends TitanEdgeAgent {
  private chat: ReturnType<ReturnType<typeof buildModel>["startChat"]> | null = null;

  constructor() { super("Multi-Track Data Integrator", 4, 22, 1200); }

  async connect(): Promise<void> {
    const m = buildModel(
      `You are a Principal MLOps and Data Integration Engineer. You run a unified autonomous loop 
over Fivetran pipeline health and Arize Phoenix LLM observability.

EXECUTION LOOP:
1. list_connectors — enumerate all connectors. Compute volume delta between last two syncs:
   delta% = (current_rows - prev_rows) / prev_rows * 100.
   FLAG: delta < -50% (data loss risk) OR delta > +300% (data spike / runaway ingestion).
2. For each flagged connector: connector_sync_log (limit 10) to trace the volume anomaly timeline.
   Classify: DATA_SOURCE_OUTAGE | SCHEMA_CHANGE | PIPELINE_ERROR | RUNAWAY_INGESTION.
3. connector_schema for each flagged connector. Detect:
   - New columns added since last schema snapshot (SCHEMA_DRIFT)
   - Column type changes (TYPE_MUTATION)
   - Columns newly blocked or hashed (COLUMN_SUPPRESSION)
4. Translate each connector sync record into an Arize execution trace:
   - predictionId: "<connectorId>_<syncTimestamp>"
   - features: { rowCount, syncDurationSec, errorCount, schemaVersion, sourceName }
   - predictionLabel: "healthy" if delta within [-20%,+100%] else "anomalous"
   - actualLabel: derive from sync status (succeeded = "healthy", failed = "anomalous")
   log_arize_traces in batches of up to 25 records.
5. get_drift_scores for model=${ENV.ARIZE_MODEL_ID}. PSI interpretation:
   0.0–0.1 = stable, 0.1–0.2 = moderate drift, > 0.2 = critical distribution shift.
6. If PSI > 0.1: create_arize_monitor with threshold=0.1 and metric="psi".
   If PSI > 0.2: ALSO pause_connector for each flagged connector with a descriptive reason.
7. Output JSON pipeline health report: { totalConnectors, flaggedConnectors[], driftScores{}, 
   monitorsCreated[], connectorsPaused[], schemaChanges[], recommendedActions[] }`,
      FT_ARIZE_FUNCTIONS
    );
    this.chat = m.startChat({ history: [] });
  }

  private async ft(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const creds = Buffer.from(`${ENV.FIVETRAN_API_KEY}:${ENV.FIVETRAN_API_SECRET}`).toString("base64");
    const r = await fetch(`https://api.fivetran.com/v1${path}`, {
      method,
      headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`Fivetran ${method} ${path} → ${r.status}: ${await r.text()}`);
    return r.json();
  }

  private async arize(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const r = await fetch(`https://api.arize.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${ENV.ARIZE_API_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`Arize ${method} ${path} → ${r.status}: ${await r.text()}`);
    return r.json();
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const t = Date.now();
    let out: unknown;

    switch (tool) {
      case "list_connectors": {
        const p = new URLSearchParams({ limit: String(args.limit ?? 50) });
        if (args.groupId) p.set("group_id", String(args.groupId));
        if (args.cursor) p.set("cursor", String(args.cursor));
        out = await this.ft(`/connectors?${p}`);
        break;
      }
      case "connector_sync_log": {
        out = await this.ft(`/connectors/${args.connectorId}/logs?limit=${args.limit ?? 10}`);
        break;
      }
      case "connector_schema": {
        out = await this.ft(`/connectors/${args.connectorId}/schemas`);
        break;
      }
      case "pause_connector": {
        out = await this.ft(`/connectors/${args.connectorId}`, "PATCH", { paused: true });
        this.remediation({ type: "fivetran_paused", description: `Connector ${args.connectorId} paused: ${args.reason}`, automated: true, result: out });
        this.finding({ severity: "high", category: "connector_paused", message: `Fivetran connector ${args.connectorId} paused due to: ${args.reason}`, evidence: args });
        break;
      }
      case "log_arize_traces": {
        out = await this.arize("/log", "POST", {
          space_id: ENV.ARIZE_SPACE_ID,
          model_id: String(args.modelId ?? ENV.ARIZE_MODEL_ID),
          model_version: String(args.modelVersion ?? "2.0.0"),
          environment: args.environment ?? "production",
          records: args.records,
        });
        break;
      }
      case "get_drift_scores": {
        const p = new URLSearchParams({
          model_id: String(args.modelId),
          space_id: ENV.ARIZE_SPACE_ID,
          start_time: String(args.startTime ?? new Date(Date.now() - 3_600_000).toISOString()),
          end_time: String(args.endTime ?? new Date().toISOString()),
        });
        if (Array.isArray(args.metricTypes)) p.set("metrics", (args.metricTypes as string[]).join(","));
        out = await this.arize(`/drift?${p}`);
        const d = out as { psi?: number };
        if (d.psi !== undefined) {
          const sev: Severity = d.psi > 0.2 ? "critical" : d.psi > 0.1 ? "high" : "info";
          this.finding({ severity: sev, category: "arize_psi_drift", message: `PSI drift score ${d.psi.toFixed(4)} for model ${args.modelId} (critical threshold: 0.20)`, evidence: d });
        }
        break;
      }
      case "create_arize_monitor": {
        out = await this.arize("/monitors", "POST", {
          space_id: ENV.ARIZE_SPACE_ID,
          model_id: args.modelId,
          name: args.monitorName,
          metric: args.metric,
          threshold: args.threshold,
          operator: args.operator ?? "greater_than",
          notification_channels: args.channels ?? [],
          enabled: true,
          created_by: "TitanU-Integrator-Agent-v2",
        });
        this.remediation({ type: "arize_monitor_created", description: `Arize monitor "${args.monitorName}" created (${args.metric} > ${args.threshold})`, automated: true, result: out });
        break;
      }
      default: throw new Error(`Unknown FT/Arize tool: ${tool}`);
    }

    this.record(tool, args, out, Date.now() - t);
    return out;
  }

  async run(): Promise<AgentResult> {
    const t0 = Date.now();
    if (!this.chat) await this.connect();
    try {
      let resp = await this.chat!.sendMessage(
        "BEGIN INTEGRATION_CYCLE. Enumerate all Fivetran connectors. Detect volume anomalies and schema drift. Pipe execution traces to Arize Phoenix. Score LLM drift via PSI. Create monitors and pause anomalous connectors. Produce the pipeline health report."
      );
      for (let i = 0; i < this.maxIterations; i++) {
        const parts = resp.response.candidates?.[0]?.content?.parts ?? [];
        const fns = parts.filter((p: Part) => (p as { functionCall?: unknown }).functionCall);
        if (fns.length === 0) {
          const txt = (parts.find((p: Part) => (p as { text?: string }).text) as { text?: string });
          if (txt?.text) this.finding({ severity: "info", category: "pipeline_health_report", message: txt.text, evidence: { iter: i } });
          break;
        }
        const results: Part[] = [];
        for (const part of fns) {
          const fc = (part as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
          try {
            const r = await this.dispatch(fc.name, fc.args);
            results.push({ functionResponse: { name: fc.name, response: { content: JSON.stringify(r) } } } as Part);
          } catch (e) {
            results.push({ functionResponse: { name: fc.name, response: { content: `Error: ${(e as Error).message}` } } } as Part);
          }
        }
        resp = await this.chat!.sendMessage(results);
        await sleep(this.iterDelayMs);
      }
      return this.result(true, Date.now() - t0);
    } catch (e) {
      return this.result(false, Date.now() - t0, (e as Error).message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  TRACK 5 — SECURITY COMPLIANCE AGENT (GITLAB MCP)
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

// CWE-mapped secret and vulnerability pattern scanner
const SECRET_SCAN_PATTERNS: Array<{
  id: string; cwe: string; severity: Severity; pattern: RegExp;
}> = [
  { id: "AWS_ACCESS_KEY_ID",          cwe: "CWE-798", severity: "critical", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "AWS_SECRET_ACCESS_KEY",      cwe: "CWE-798", severity: "critical", pattern: /(?:aws_secret_access_key|AWS_SECRET)[^=\n]*=\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  { id: "GCP_SERVICE_ACCOUNT_KEY",    cwe: "CWE-798", severity: "critical", pattern: /"private_key_id"\s*:\s*"[a-f0-9]{40}"/g },
  { id: "GOOGLE_API_KEY",             cwe: "CWE-798", severity: "critical", pattern: /AIza[0-9A-Za-z\-_]{35}/g },
  { id: "GITHUB_TOKEN",               cwe: "CWE-798", severity: "critical", pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/g },
  { id: "GITLAB_PAT",                 cwe: "CWE-798", severity: "critical", pattern: /glpat-[A-Za-z0-9\-_]{20}/g },
  { id: "STRIPE_LIVE_KEY",            cwe: "CWE-798", severity: "critical", pattern: /sk_live_[A-Za-z0-9]{24,}/g },
  { id: "PRIVATE_RSA_KEY",            cwe: "CWE-321", severity: "critical", pattern: /-----BEGIN RSA PRIVATE KEY-----/g },
  { id: "PRIVATE_EC_KEY",             cwe: "CWE-321", severity: "critical", pattern: /-----BEGIN EC PRIVATE KEY-----/g },
  { id: "PRIVATE_OPENSSH_KEY",        cwe: "CWE-321", severity: "critical", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g },
  { id: "MONGODB_URI_WITH_CREDS",     cwe: "CWE-312", severity: "critical", pattern: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s'"`,]/g },
  { id: "SLACK_TOKEN",                cwe: "CWE-798", severity: "high",     pattern: /xox[baprs]-[A-Za-z0-9\-]{10,48}/g },
  { id: "SENDGRID_KEY",               cwe: "CWE-798", severity: "high",     pattern: /SG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}/g },
  { id: "JWT_SECRET_HARDCODED",       cwe: "CWE-798", severity: "high",     pattern: /jwt[_\-]?secret\s*[=:]\s*['"`][A-Za-z0-9!@#$%^&*]{16,}['"`]/gi },
  { id: "DB_PASSWORD_HARDCODED",      cwe: "CWE-259", severity: "high",     pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"`][^\s'"`,]{8,}['"`]/gi },
];

const VULN_SCAN_PATTERNS: Array<{
  id: string; cwe: string; severity: Severity; description: string; pattern: RegExp; fix: string;
}> = [
  {
    id: "SQL_INJECTION", cwe: "CWE-89", severity: "critical",
    description: "SQL injection via string concatenation in query construction",
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE)\s+[^;]*\$\{[^}]+\}|db\.(?:query|execute)\s*\(\s*[`'"][^`'"]*\+/gi,
    fix: "Use parameterized queries or prepared statements. Never interpolate user input directly into SQL.",
  },
  {
    id: "EVAL_USER_INPUT", cwe: "CWE-95", severity: "critical",
    description: "eval() called with user-controlled input — arbitrary code execution",
    pattern: /\beval\s*\([^)]*(?:req\.|request\.|body\.|params\.|query\.)[^)]*\)/gi,
    fix: "Remove eval(). Use JSON.parse() for data, or redesign the logic to avoid dynamic code evaluation.",
  },
  {
    id: "CHILD_PROCESS_INJECTION", cwe: "CWE-78", severity: "critical",
    description: "Shell command built from user input — OS command injection",
    pattern: /(?:exec|execSync|spawn|spawnSync)\s*\([^)]*(?:req\.|request\.|body\.|params\.|query\.)[^)]*\)/gi,
    fix: "Never concatenate user input into shell commands. Use execFile() with an array of arguments.",
  },
  {
    id: "PATH_TRAVERSAL", cwe: "CWE-22", severity: "high",
    description: "File system operation with user-controlled path — directory traversal risk",
    pattern: /(?:readFile|writeFile|readFileSync|createReadStream)\s*\([^)]*(?:req\.|request\.|body\.|params\.|query\.)[^)]*\)/gi,
    fix: "Resolve paths with path.resolve() and verify they are within an allowed base directory before any FS operation.",
  },
  {
    id: "PROTOTYPE_POLLUTION", cwe: "CWE-1321", severity: "high",
    description: "Prototype pollution — __proto__ or constructor manipulation",
    pattern: /\[\s*['"`]__proto__['"`]\s*\]|Object\.assign\s*\(\s*(?:\{\s*\}|target)\s*,\s*(?:req|body|params|query)/gi,
    fix: "Use Object.create(null) for data-holding objects. Validate that user keys cannot be __proto__, constructor, or prototype.",
  },
  {
    id: "INSECURE_RANDOMNESS", cwe: "CWE-338", severity: "high",
    description: "Math.random() used for security-sensitive value — cryptographically weak",
    pattern: /Math\.random\(\)[^;]*(?:token|secret|nonce|key|password|salt|csrf|session)/gi,
    fix: "Replace Math.random() with crypto.getRandomValues() or crypto.randomBytes() for all security tokens.",
  },
  {
    id: "CORS_WILDCARD", cwe: "CWE-942", severity: "medium",
    description: "Wildcard CORS header allows any origin — overly permissive cross-origin policy",
    pattern: /(?:Access-Control-Allow-Origin|origin)['":\s]*\*/gi,
    fix: "Restrict CORS to an explicit allowlist of trusted origins. Never use '*' in production APIs.",
  },
  {
    id: "HARDCODED_IP_PRODUCTION", cwe: "CWE-1188", severity: "low",
    description: "Hardcoded IP address may embed non-public infrastructure detail",
    pattern: /(?:host|url|endpoint|baseUrl)\s*[=:]\s*['"`]\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}['"`]/gi,
    fix: "Use environment variables or service discovery for all host addresses.",
  },
];

interface ScanHit {
  type: "secret" | "vulnerability";
  id: string;
  cwe: string;
  severity: Severity;
  description: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
  fix?: string;
}

function scanDiff(diffs: Array<{ new_path: string; diff: string }>): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const { new_path, diff } of diffs) {
    const lines = diff.split("\n");
    let lineNumber = 0;
    for (const line of lines) {
      if (line.startsWith("@@")) {
        // Extract new file line number from hunk header
        const m = line.match(/@@ [^+]*\+(\d+)/);
        lineNumber = m ? parseInt(m[1], 10) - 1 : lineNumber;
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        lineNumber++;
        const content = line.slice(1);
        for (const p of SECRET_SCAN_PATTERNS) {
          if (p.pattern.test(content)) {
            hits.push({ type: "secret", id: p.id, cwe: p.cwe, severity: p.severity, description: `Hardcoded secret: ${p.id}`, filePath: new_path, lineNumber, snippet: content.substring(0, 120) });
          }
          p.pattern.lastIndex = 0;
        }
        for (const p of VULN_SCAN_PATTERNS) {
          if (p.pattern.test(content)) {
            hits.push({ type: "vulnerability", id: p.id, cwe: p.cwe, severity: p.severity, description: p.description, filePath: new_path, lineNumber, snippet: content.substring(0, 120), fix: p.fix });
          }
          p.pattern.lastIndex = 0;
        }
      } else if (!line.startsWith("-")) {
        lineNumber++;
      }
    }
  }
  return hits;
}

const GITLAB_FUNCTIONS: FunctionDeclaration[] = [
  {
    name: "list_open_mrs",
    description: "List all open merge requests for the GitLab project",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        limit: { type: "number" },
        orderBy: { type: "string" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "get_mr_diff",
    description: "Fetch the full file diffs for a merge request (already pre-scanned for security; scan results included)",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        mrIid: { type: "number" },
      },
      required: ["projectId", "mrIid"],
    },
  },
  {
    name: "get_mr_author",
    description: "Get the author username of a merge request for issue assignment",
    parameters: {
      type: "object",
      properties: { projectId: { type: "string" }, mrIid: { type: "number" } },
      required: ["projectId", "mrIid"],
    },
  },
  {
    name: "create_security_issue",
    description: "Open a confidential GitLab security remediation issue and assign it to the MR author",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        assigneeUsername: { type: "string" },
        confidential: { type: "boolean" },
        weight: { type: "number", description: "1=critical,2=high,3=medium,4=low" },
      },
      required: ["projectId", "title", "description"],
    },
  },
  {
    name: "add_inline_mr_comment",
    description: "Add an inline security comment to a specific file+line in a merge request diff",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        mrIid: { type: "number" },
        body: { type: "string" },
        filePath: { type: "string" },
        newLine: { type: "number" },
      },
      required: ["projectId", "mrIid", "body"],
    },
  },
  {
    name: "block_mr_merge",
    description: "Block a merge request from being merged by removing approvals (requires Maintainer role)",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        mrIid: { type: "number" },
        reason: { type: "string" },
      },
      required: ["projectId", "mrIid", "reason"],
    },
  },
];

class GitLabSecurityComplianceAgent extends TitanEdgeAgent {
  private chat: ReturnType<ReturnType<typeof buildModel>["startChat"]> | null = null;

  constructor() { super("Security Compliance Agent", 5, 35, 700); }

  async connect(): Promise<void> {
    this.mcp = await mcpStdio(
      "npx",
      ["-y", "@modelcontextprotocol/server-gitlab"],
      {
        GITLAB_PERSONAL_ACCESS_TOKEN: ENV.GITLAB_TOKEN,
        GITLAB_API_URL: `${ENV.GITLAB_URL.replace(/\/$/, "")}/api/v4`,
      }
    );
    const m = buildModel(
      `You are a Principal Application Security Engineer operating an autonomous SAST gate 
on a GitLab project's merge request pipeline.

EXECUTION LOOP:
1. list_open_mrs for projectId=${ENV.GITLAB_PROJECT_ID}. Process each MR in severity-first order 
   (most recently updated first to catch hot PRs).
2. get_mr_diff for each MR. The response includes pre-scanned security findings in the 
   "securityScanResults" field. Do NOT re-scan; work from those findings.
3. get_mr_author for each MR with findings so you can assign issues.
4. For each scan finding:
   a. add_inline_mr_comment on the exact file+line with:
      "⚠️ **[<SEVERITY>] <ID> (<CWE>)**\\n<description>\\n\\n**Fix:** <fix>\\n\\nAutomated by TitanU Security Compliance Agent"
   b. create_security_issue with:
      Title: "[SEC-<SEVERITY>] <ID> in <filename>:<line> (MR !<iid>)"
      Description (markdown): severity badge, CWE reference, affected file+line, code snippet 
      (redacted to 80 chars), root cause explanation, step-by-step remediation with code examples, 
      OWASP/NIST reference, and "Detected by TitanU Security Compliance Agent v2.0".
      Labels: ["security","sast","<severity>","auto-remediation-needed"]
      Confidential: true for critical/high
      Weight: 1 for critical, 2 for high, 3 for medium, 4 for low
      Assigned to: MR author username
   c. If ANY finding is critical severity: block_mr_merge with reason listing all critical finding IDs.
5. After all MRs processed, output the Security Compliance Report JSON:
   { mrsScanned, findingsBySeverity:{critical,high,medium,low}, mrsBlocked[], issuesCreated, 
     topVulnerabilityClasses:[{id,cwe,count}], topSecretTypes:[{id,cwe,count}], cleanMrs[] }`,
      GITLAB_FUNCTIONS
    );
    this.chat = m.startChat({ history: [] });
  }

  private async gl(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const base = ENV.GITLAB_URL.replace(/\/$/, "");
    const r = await fetch(`${base}/api/v4${path}`, {
      method,
      headers: { "PRIVATE-TOKEN": ENV.GITLAB_TOKEN, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`GitLab ${method} ${path} → ${r.status}: ${await r.text()}`);
    if (r.status === 204) return {};
    return r.json();
  }

  private async dispatch(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const t = Date.now();
    let out: unknown;
    const pid = encodeURIComponent(String(args.projectId));

    switch (tool) {
      case "list_open_mrs": {
        const p = new URLSearchParams({
          state: "opened",
          per_page: String(args.limit ?? 20),
          order_by: String(args.orderBy ?? "updated_at"),
          sort: "desc",
        });
        out = await this.gl(`/projects/${pid}/merge_requests?${p}`);
        break;
      }
      case "get_mr_diff": {
        const rawDiffs = await this.gl(`/projects/${pid}/merge_requests/${args.mrIid}/diffs`) as Array<{ new_path: string; diff: string }>;
        const hits = scanDiff(rawDiffs);
        for (const h of hits) {
          this.finding({ severity: h.severity, category: `sast_${h.type}_${h.id}`, message: `${h.id} (${h.cwe}) in ${h.filePath}:${h.lineNumber} — MR !${args.mrIid}`, evidence: h });
        }
        out = {
          diffs: rawDiffs,
          securityScanResults: {
            hits,
            criticalCount: hits.filter((h) => h.severity === "critical").length,
            highCount:     hits.filter((h) => h.severity === "high").length,
            mediumCount:   hits.filter((h) => h.severity === "medium").length,
            lowCount:      hits.filter((h) => h.severity === "low").length,
          },
        };
        break;
      }
      case "get_mr_author": {
        const mr = await this.gl(`/projects/${pid}/merge_requests/${args.mrIid}`) as { author?: { username: string } };
        out = { username: mr.author?.username ?? "unknown" };
        break;
      }
      case "create_security_issue": {
        out = await this.gl(`/projects/${pid}/issues`, "POST", {
          title: args.title,
          description: args.description,
          labels: (args.labels as string[] ?? []).join(","),
          assignee_usernames: args.assigneeUsername ? [args.assigneeUsername] : [],
          confidential: args.confidential ?? false,
          weight: args.weight ?? 2,
        });
        this.remediation({ type: "security_issue_created", description: `Issue created: ${args.title}`, automated: true, result: out });
        break;
      }
      case "add_inline_mr_comment": {
        if (args.filePath && args.newLine) {
          out = await this.gl(`/projects/${pid}/merge_requests/${args.mrIid}/discussions`, "POST", {
            body: args.body,
            position: { position_type: "text", new_path: args.filePath, new_line: args.newLine },
          });
        } else {
          out = await this.gl(`/projects/${pid}/merge_requests/${args.mrIid}/notes`, "POST", { body: args.body });
        }
        this.remediation({ type: "mr_comment_added", description: `Inline security comment on MR !${args.mrIid} at ${args.filePath}:${args.newLine}`, automated: true, result: out });
        break;
      }
      case "block_mr_merge": {
        // Unapprove and add a blocking note
        await this.gl(`/projects/${pid}/merge_requests/${args.mrIid}/unapprove`, "POST").catch(() => null);
        out = await this.gl(`/projects/${pid}/merge_requests/${args.mrIid}/notes`, "POST", {
          body: `🚫 **MERGE BLOCKED by TitanU Security Compliance Agent**\n\n**Reason:** ${args.reason}\n\nThis MR contains critical security findings. All issues labeled \`security\` + \`critical\` must be resolved and re-reviewed before merge.`,
        });
        this.remediation({ type: "mr_blocked", description: `MR !${args.mrIid} merge blocked: ${args.reason}`, automated: true, result: out });
        break;
      }
      default: throw new Error(`Unknown GitLab tool: ${tool}`);
    }

    this.record(tool, args, out, Date.now() - t);
    return out;
  }

  async run(): Promise<AgentResult> {
    const t0 = Date.now();
    if (!this.chat) await this.connect();
    try {
      let resp = await this.chat!.sendMessage(
        `BEGIN SECURITY_SCAN for project ${ENV.GITLAB_PROJECT_ID}. List all open MRs. For each: diff, scan, comment, create issues, block criticals. Output the Security Compliance Report.`
      );
      for (let i = 0; i < this.maxIterations; i++) {
        const parts = resp.response.candidates?.[0]?.content?.parts ?? [];
        const fns = parts.filter((p: Part) => (p as { functionCall?: unknown }).functionCall);
        if (fns.length === 0) {
          const txt = (parts.find((p: Part) => (p as { text?: string }).text) as { text?: string });
          if (txt?.text) this.finding({ severity: "info", category: "security_compliance_report", message: txt.text, evidence: { iter: i } });
          break;
        }
        const results: Part[] = [];
        for (const part of fns) {
          const fc = (part as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
          try {
            const r = await this.dispatch(fc.name, fc.args);
            results.push({ functionResponse: { name: fc.name, response: { content: JSON.stringify(r) } } } as Part);
          } catch (e) {
            results.push({ functionResponse: { name: fc.name, response: { content: `Error: ${(e as Error).message}` } } } as Part);
          }
        }
        resp = await this.chat!.sendMessage(results);
        await sleep(this.iterDelayMs);
      }
      return this.result(true, Date.now() - t0);
    } catch (e) {
      return this.result(false, Date.now() - t0, (e as Error).message);
    } finally { await this.disconnect(); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//  TITAN ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────

interface OrchestratorOptions {
  parallel: boolean;
  tracks: number[];
  outputFile: string;
  webhookUrl?: string;
}

const AGENT_REGISTRY: Map<number, () => TitanEdgeAgent> = new Map([
  [1, () => new DynatraceAutonomousSREAgent()],
  [2, () => new ElasticTelemetryDetective()],
  [3, () => new MongoDBShardingEvolutionAgent()],
  [4, () => new FivetranArizeIntegratorAgent()],
  [5, () => new GitLabSecurityComplianceAgent()],
]);

class TitanOrchestrator {
  async run(opts: OrchestratorOptions): Promise<AgentResult[]> {
    const agents = opts.tracks
      .filter((t) => AGENT_REGISTRY.has(t))
      .map((t) => AGENT_REGISTRY.get(t)!());

    this.banner(opts);

    const wire = (agent: TitanEdgeAgent) => {
      agent.on("finding", (f: Finding) =>
        process.stdout.write(`  [Track ${agent["track"]}][${f.severity.toUpperCase().padEnd(8)}] ${f.category}: ${f.message.substring(0, 120)}\n`)
      );
      agent.on("remediation", (r: Remediation) =>
        process.stdout.write(`  [Track ${agent["track"]}][REMEDIATE ] ${r.type}: ${r.description.substring(0, 120)}\n`)
      );
    };

    agents.forEach(wire);

    let results: AgentResult[];
    if (opts.parallel) {
      const settled = await Promise.allSettled(agents.map((a) => a.run()));
      results = settled.map((s, i) =>
        s.status === "fulfilled"
          ? s.value
          : { agentName: agents[i]["name"], track: agents[i]["track"], success: false, iterations: 0, actions: [], findings: [], remediations: [], elapsedMs: 0, error: String((s as PromiseRejectedResult).reason) }
      );
    } else {
      results = [];
      for (const agent of agents) results.push(await agent.run());
    }

    this.summary(results);
    await this.writeOutput(opts.outputFile, opts, results);
    if (opts.webhookUrl) await this.webhook(opts.webhookUrl, results);
    return results;
  }

  private banner(opts: OrchestratorOptions) {
    const line = "═".repeat(62);
    console.log(`\n${line}`);
    console.log("  TitanU Edge AI Agent Orchestrator v2.0.0");
    console.log("  Google Cloud Rapid Agent Hackathon");
    console.log(`  Tracks: ${opts.tracks.join(", ")} | Mode: ${opts.parallel ? "PARALLEL" : "SEQUENTIAL"}`);
    console.log(`  Model: ${ENV.GEMINI_MODEL}`);
    console.log(`${line}\n`);
  }

  private summary(results: AgentResult[]) {
    const line = "─".repeat(62);
    console.log(`\n${line}`);
    console.log("ORCHESTRATION SUMMARY");
    console.log(line);
    let tFindings = 0, tRemeds = 0, tCrit = 0;
    for (const r of results) {
      const crit = r.findings.filter((f) => f.severity === "critical").length;
      const high = r.findings.filter((f) => f.severity === "high").length;
      tFindings += r.findings.length; tRemeds += r.remediations.length; tCrit += crit;
      console.log(`Track ${r.track}: ${r.agentName}`);
      console.log(`  ${r.success ? "✓ SUCCESS" : "✗ FAILED"} | ${r.elapsedMs}ms | ${r.findings.length} findings (${crit} critical, ${high} high) | ${r.remediations.length} remediations`);
      if (r.error) console.log(`  ERROR: ${r.error}`);
    }
    console.log(line);
    console.log(`TOTAL: ${tFindings} findings | ${tRemeds} remediations | ${tCrit} critical`);
    console.log(`${line}\n`);
  }

  private async writeOutput(file: string, opts: OrchestratorOptions, results: AgentResult[]) {
    await fs.writeFile(
      file,
      JSON.stringify({ orchestrationId: crypto.randomUUID(), timestamp: new Date().toISOString(), model: ENV.GEMINI_MODEL, options: opts, results }, null, 2)
    );
    console.log(`Results written → ${file}`);
  }

  private async webhook(url: string, results: AgentResult[]) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "TitanU-Edge-Agent-v2",
          timestamp: new Date().toISOString(),
          summary: {
            totalAgents: results.length,
            successCount: results.filter((r) => r.success).length,
            totalFindings: results.reduce((s, r) => s + r.findings.length, 0),
            criticalFindings: results.reduce((s, r) => s + r.findings.filter((f) => f.severity === "critical").length, 0),
            totalRemediations: results.reduce((s, r) => s + r.remediations.length, 0),
          },
          results,
        }),
      });
      console.log(`Webhook delivered → ${url}`);
    } catch (e) {
      console.warn(`Webhook failed: ${(e as Error).message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const argv = process.argv.slice(2);
  const parallel   = argv.includes("--parallel");
  const tracksArg  = argv.find((a) => a.startsWith("--tracks="));
  const tracks     = tracksArg ? tracksArg.replace("--tracks=", "").split(",").map(Number) : [1, 2, 3, 4, 5];
  const outputFile = argv.find((a) => a.startsWith("--output="))?.replace("--output=", "") ?? `titan-results-${Date.now()}.json`;
  const webhookUrl = argv.find((a) => a.startsWith("--webhook="))?.replace("--webhook=", "");

  process.on("SIGINT",  () => { console.log("\nSIGINT — shutting down."); process.exit(0); });
  process.on("SIGTERM", () => { console.log("\nSIGTERM — shutting down."); process.exit(0); });
  process.on("uncaughtException", (e) => { console.error("Uncaught:", e); process.exit(1); });

  try {
    await new TitanOrchestrator().run({ parallel, tracks, outputFile, webhookUrl });
    process.exit(0);
  } catch (e) {
    console.error("Fatal orchestration error:", (e as Error).message);
    process.exit(1);
  }
})();
