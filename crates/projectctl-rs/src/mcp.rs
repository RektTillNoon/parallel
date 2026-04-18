use std::{
    io::{self, BufRead, BufReader, Write},
    sync::Arc,
};

use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use parallel_workflow_core::{
    add_blocker, append_activity_event, clear_blocker, complete_step, ensure_session, get_project,
    list_projects, propose_decision, refresh_handoff, resolve_watched_roots, start_step,
    sync_plan, update_runtime, ActivitySource, AppendActivityInput, DecisionProposalInput,
    EnsureSessionInput, MutationActor, PlanSyncPhaseInput, PlanSyncStepInput,
    PlanSyncSubtaskInput, RootResolutionSurface, RuntimePatchInput, SessionContextInput,
    SyncPlanInput, SubtaskStatus,
};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const JSONRPC_VERSION: &str = "2.0";
const SERVER_NAME: &str = "parallel-agent-bridge";
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone)]
pub struct ServeHttpConfig {
    pub port: u16,
    pub token: String,
    pub watched_roots: Vec<String>,
    pub index_db_path: String,
}

#[derive(Clone)]
pub struct ProxyStdioConfig {
    pub url: String,
    pub token: String,
}

#[derive(Clone)]
struct HttpState {
    backend: Arc<dyn ToolBackend>,
    bound_port: u16,
    token: String,
}

trait ToolBackend: Send + Sync {
    fn execute(&self, name: &str, args: Value) -> Result<Value>;
}

#[derive(Clone)]
struct LocalBackend {
    watched_roots: Vec<String>,
    index_db_path: String,
}

#[derive(Clone)]
struct RemoteBackend {
    client: reqwest::blocking::Client,
    url: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    id: Value,
    result: Value,
}

#[derive(Debug, Serialize)]
struct JsonRpcErrorResponse {
    jsonrpc: &'static str,
    id: Value,
    error: JsonRpcError,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct ToolDescriptor {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    #[serde(rename = "inputSchema")]
    input_schema: Value,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ListProjectsArgs {
    #[serde(default)]
    roots: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetProjectArgs {
    root: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SyncPlanArgs {
    root: String,
    #[serde(default = "default_mcp_actor")]
    actor: String,
    #[serde(default = "default_mcp_source")]
    source: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_title: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    phases: Vec<PlanPhasePayload>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PlanPhasePayload {
    #[serde(default)]
    id: Option<String>,
    title: String,
    steps: Vec<PlanStepPayload>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PlanStepPayload {
    #[serde(default)]
    id: Option<String>,
    title: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    details: Option<Vec<String>>,
    #[serde(default)]
    depends_on: Option<Vec<String>>,
    #[serde(default)]
    subtasks: Option<Vec<PlanSubtaskPayload>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PlanSubtaskPayload {
    #[serde(default)]
    id: Option<String>,
    title: String,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EnsureSessionArgs {
    root: String,
    #[serde(default = "default_mcp_actor")]
    actor: String,
    #[serde(default = "default_mcp_source")]
    source: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_title: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UpdateRuntimeArgs {
    root: String,
    #[serde(default = "default_mcp_actor")]
    actor: String,
    #[serde(default = "default_mcp_source")]
    source: String,
    summary: String,
    patch: Map<String, Value>,
    #[serde(default)]
    event_type: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AppendActivityArgs {
    root: String,
    actor: String,
    source: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_title: Option<String>,
    #[serde(rename = "type")]
    event_type: String,
    summary: String,
    #[serde(default)]
    step_id: Option<String>,
    #[serde(default)]
    subtask_id: Option<String>,
    #[serde(default)]
    payload: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct StepMutationArgs {
    root: String,
    step_id: String,
    #[serde(default = "default_mcp_actor")]
    actor: String,
    #[serde(default = "default_mcp_source")]
    source: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_title: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SetBlockerArgs {
    root: String,
    #[serde(default = "default_mcp_actor")]
    actor: String,
    #[serde(default = "default_mcp_source")]
    source: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_title: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    blocker: Option<String>,
    #[serde(default)]
    clear: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RefreshHandoffArgs {
    root: String,
    #[serde(default = "default_mcp_actor")]
    actor: String,
    #[serde(default = "default_mcp_source")]
    source: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ProposeDecisionArgs {
    root: String,
    #[serde(default = "default_mcp_actor")]
    actor: String,
    #[serde(default = "default_mcp_source")]
    source: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    session_title: Option<String>,
    title: String,
    context: String,
    decision: String,
    impact: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    #[serde(default)]
    protocol_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Option<Value>,
}

pub async fn run_serve_http(config: ServeHttpConfig) -> Result<()> {
    let backend: Arc<dyn ToolBackend> = Arc::new(LocalBackend {
        watched_roots: config.watched_roots,
        index_db_path: config.index_db_path,
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.port))
        .await
        .with_context(|| format!("failed to bind HTTP bridge to 127.0.0.1:{}", config.port))?;
    let bound_port = listener.local_addr()?.port();

    let state = HttpState {
        backend,
        bound_port,
        token: config.token,
    };

    println!("AGENT_BRIDGE_READY {bound_port}");
    let _ = io::stdout().flush();

    let router = Router::new()
        .route("/health", get(handle_health))
        .route("/mcp", post(handle_mcp))
        .with_state(state);

    axum::serve(listener, router)
        .await
        .context("streamable HTTP server exited unexpectedly")?;
    Ok(())
}

pub fn run_proxy_stdio(config: ProxyStdioConfig) -> Result<()> {
    let backend = RemoteBackend {
        client: reqwest::blocking::Client::builder()
            .build()
            .context("failed to build proxy HTTP client")?,
        url: config.url,
        token: config.token,
    };

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();

    loop {
        let Some(request) = read_stdio_message(&mut reader)? else {
            return Ok(());
        };

        if let Some(response) = dispatch_request(&backend, request) {
            write_stdio_message(&mut writer, &response)?;
        }
    }
}

fn read_stdio_message<R: BufRead>(reader: &mut R) -> Result<Option<JsonRpcRequest>> {
    let mut content_length = None;

    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            return Ok(None);
        }

        if line == "\r\n" || line == "\n" {
            break;
        }

        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .context("invalid Content-Length header")?,
                );
            }
        }
    }

    let length = content_length.ok_or_else(|| anyhow!("missing Content-Length header"))?;
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let payload = serde_json::from_slice(&body).context("invalid stdio JSON-RPC payload")?;
    Ok(Some(payload))
}

fn write_stdio_message<W: Write>(writer: &mut W, payload: &Value) -> Result<()> {
    let body = serde_json::to_vec(payload)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

async fn handle_health(State(state): State<HttpState>, headers: HeaderMap) -> impl IntoResponse {
    if let Err(response) = authorize(&headers, &state.token) {
        return response;
    }

    (
        StatusCode::OK,
        Json(json!({
            "version": env!("CARGO_PKG_VERSION"),
            "mode": "streamable-http",
            "boundPort": state.bound_port,
            "authMode": "bearer",
        })),
    )
        .into_response()
}

async fn handle_mcp(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    if let Err(response) = authorize(&headers, &state.token) {
        return response;
    }

    let request: JsonRpcRequest = match serde_json::from_value(payload) {
        Ok(request) => request,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(error_response(
                    Value::Null,
                    -32700,
                    format!("invalid JSON-RPC request: {error}"),
                )),
            )
                .into_response();
        }
    };

    match dispatch_request(state.backend.as_ref(), request) {
        Some(response) => (StatusCode::OK, Json(response)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

fn authorize(headers: &HeaderMap, token: &str) -> Result<(), axum::response::Response> {
    let Some(value) = headers.get("authorization") else {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({ "error": "missing authorization" }))).into_response());
    };
    let expected = format!("Bearer {token}");
    if value.to_str().ok() != Some(expected.as_str()) {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({ "error": "invalid bearer token" }))).into_response());
    }
    Ok(())
}

fn dispatch_request(backend: &dyn ToolBackend, request: JsonRpcRequest) -> Option<Value> {
    let id = request.id.clone().unwrap_or(Value::Null);

    let response = match dispatch_method(backend, request) {
        Ok(Some(result)) => response_payload(id, result),
        Ok(None) => return None,
        Err((code, message, response_id)) => error_response(response_id.unwrap_or(id), code, message),
    };

    Some(response)
}

fn dispatch_method(backend: &dyn ToolBackend, request: JsonRpcRequest) -> Result<Option<Value>, (i32, String, Option<Value>)> {
    if request.jsonrpc.as_deref() != Some(JSONRPC_VERSION) {
        return Err((-32600, "jsonrpc must be 2.0".to_string(), request.id));
    }

    match request.method.as_str() {
        "initialize" => {
            let params: InitializeParams = deserialize_params(request.params, request.id.clone())?;
            Ok(Some(json!({
                "protocolVersion": params.protocol_version.unwrap_or_else(|| DEFAULT_PROTOCOL_VERSION.to_string()),
                "capabilities": {
                    "tools": {
                        "listChanged": false
                    }
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": env!("CARGO_PKG_VERSION")
                }
            })))
        }
        "notifications/initialized" => Ok(None),
        "ping" => Ok(Some(json!({}))),
        "tools/list" => Ok(Some(json!({ "tools": tool_definitions() }))),
        "tools/call" => {
            let params: ToolCallParams = deserialize_params(request.params, request.id.clone())?;
            let args = params.arguments.unwrap_or_else(|| Value::Object(Map::new()));
            match backend.execute(&params.name, args) {
                Ok(payload) => Ok(Some(json!({
                    "content": [
                        {
                            "type": "text",
                            "text": serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string())
                        }
                    ],
                    "isError": false
                }))),
                Err(error) => Ok(Some(json!({
                    "content": [
                        {
                            "type": "text",
                            "text": error.to_string()
                        }
                    ],
                    "isError": true
                }))),
            }
        }
        _ => Err((-32601, format!("unsupported method {}", request.method), request.id)),
    }
}

fn deserialize_params<T: for<'de> Deserialize<'de>>(params: Option<Value>, id: Option<Value>) -> Result<T, (i32, String, Option<Value>)> {
    let params = params.unwrap_or_else(|| Value::Object(Map::new()));
    serde_json::from_value(params).map_err(|error| (-32602, error.to_string(), id))
}

fn response_payload(id: Value, result: Value) -> Value {
    serde_json::to_value(JsonRpcResponse {
        jsonrpc: JSONRPC_VERSION,
        id,
        result,
    })
    .expect("serializing JSON-RPC response should not fail")
}

fn error_response(id: Value, code: i32, message: String) -> Value {
    serde_json::to_value(JsonRpcErrorResponse {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: JsonRpcError { code, message },
    })
    .expect("serializing JSON-RPC error response should not fail")
}

impl ToolBackend for LocalBackend {
    fn execute(&self, name: &str, args: Value) -> Result<Value> {
        match name {
            "list_projects" => {
                let args: ListProjectsArgs = serde_json::from_value(args)?;
                let roots = resolve_watched_roots(
                    RootResolutionSurface::Bridge,
                    args.roots.as_deref().or_else(|| {
                        if self.watched_roots.is_empty() {
                            None
                        } else {
                            Some(self.watched_roots.as_slice())
                        }
                    }),
                    None,
                    &self.index_db_path,
                    None,
                )?;
                Ok(serde_json::to_value(list_projects(&roots, &self.index_db_path)?)?)
            }
            "get_project" => {
                let args: GetProjectArgs = serde_json::from_value(args)?;
                Ok(serde_json::to_value(get_project(&args.root)?)?)
            }
            "sync_plan" => {
                let args: SyncPlanArgs = serde_json::from_value(args)?;
                let result = sync_plan(SyncPlanInput {
                    root: args.root,
                    actor: args.actor,
                    source: parse_source(&args.source),
                    session_id: args.session_id,
                    session_title: args.session_title,
                    branch: args.branch,
                    phases: args.phases.into_iter().map(into_phase_input).collect::<Result<Vec<_>>>()?,
                    index_db_path: self.index_db_path.clone(),
                })?;
                Ok(serde_json::to_value(result)?)
            }
            "ensure_session" => {
                let args: EnsureSessionArgs = serde_json::from_value(args)?;
                Ok(serde_json::to_value(ensure_session(EnsureSessionInput {
                    root: args.root,
                    actor: args.actor,
                    source: parse_source(&args.source),
                    session_id: args.session_id,
                    session_title: args.session_title,
                    branch: args.branch,
                    index_db_path: self.index_db_path.clone(),
                })?)?)
            }
            "update_runtime" => {
                let args: UpdateRuntimeArgs = serde_json::from_value(args)?;
                Ok(serde_json::to_value(update_runtime(RuntimePatchInput {
                    root: args.root,
                    actor: args.actor,
                    source: parse_source(&args.source),
                    patch: args.patch,
                    summary: args.summary,
                    event_type: args.event_type,
                    index_db_path: self.index_db_path.clone(),
                })?)?)
            }
            "append_activity" => {
                let args: AppendActivityArgs = serde_json::from_value(args)?;
                Ok(serde_json::to_value(append_activity_event(
                    &args.root,
                    AppendActivityInput {
                        actor: args.actor,
                        source: parse_source(&args.source),
                        session_id: args.session_id,
                        session_title: args.session_title,
                        branch: None,
                        event_type: args.event_type,
                        summary: args.summary,
                        payload: args.payload.map(Value::Object),
                        step_id: args.step_id,
                        subtask_id: args.subtask_id,
                        index_db_path: self.index_db_path.clone(),
                    },
                )?)?)
            }
            "start_step" => {
                let args: StepMutationArgs = serde_json::from_value(args)?;
                Ok(serde_json::to_value(start_step(
                    &args.root,
                    &args.step_id,
                    MutationActor {
                        actor: args.actor,
                        source: parse_source(&args.source),
                    },
                    SessionContextInput {
                        session_id: args.session_id,
                        session_title: args.session_title,
                        branch: args.branch,
                    },
                    &self.index_db_path,
                )?)?)
            }
            "complete_step" => {
                let args: StepMutationArgs = serde_json::from_value(args)?;
                Ok(serde_json::to_value(complete_step(
                    &args.root,
                    &args.step_id,
                    MutationActor {
                        actor: args.actor,
                        source: parse_source(&args.source),
                    },
                    SessionContextInput {
                        session_id: args.session_id,
                        session_title: args.session_title,
                        branch: args.branch,
                    },
                    &self.index_db_path,
                )?)?)
            }
            "set_blocker" => {
                let args: SetBlockerArgs = serde_json::from_value(args)?;
                let actor = MutationActor {
                    actor: args.actor,
                    source: parse_source(&args.source),
                };
                let context = SessionContextInput {
                    session_id: args.session_id,
                    session_title: args.session_title,
                    branch: args.branch,
                };
                let result = if args.clear {
                    clear_blocker(
                        &args.root,
                        args.blocker.as_deref(),
                        actor,
                        context,
                        &self.index_db_path,
                    )?
                } else {
                    let blocker = args
                        .blocker
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| anyhow!("blocker is required when clear=false"))?;
                    add_blocker(&args.root, blocker, actor, context, &self.index_db_path)?
                };
                Ok(serde_json::to_value(result)?)
            }
            "refresh_handoff" => {
                let args: RefreshHandoffArgs = serde_json::from_value(args)?;
                Ok(serde_json::to_value(refresh_handoff(
                    &args.root,
                    MutationActor {
                        actor: args.actor,
                        source: parse_source(&args.source),
                    },
                    &self.index_db_path,
                )?)?)
            }
            "propose_decision" => {
                let args: ProposeDecisionArgs = serde_json::from_value(args)?;
                Ok(serde_json::to_value(propose_decision(
                    &args.root,
                    DecisionProposalInput {
                        title: args.title,
                        context: args.context,
                        decision: args.decision,
                        impact: args.impact,
                    },
                    MutationActor {
                        actor: args.actor,
                        source: parse_source(&args.source),
                    },
                    SessionContextInput {
                        session_id: args.session_id,
                        session_title: args.session_title,
                        branch: None,
                    },
                    &self.index_db_path,
                )?)?)
            }
            _ => bail!("unknown tool: {name}"),
        }
    }
}

impl ToolBackend for RemoteBackend {
    fn execute(&self, name: &str, args: Value) -> Result<Value> {
        let response = self
            .client
            .post(&self.url)
            .header("Authorization", format!("Bearer {}", self.token))
            .json(&json!({
                "jsonrpc": JSONRPC_VERSION,
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": args
                }
            }))
            .send()
            .with_context(|| format!("failed to call remote bridge tool {name}"))?;

        if !response.status().is_success() {
            bail!("remote bridge returned HTTP {}", response.status());
        }

        let payload: Value = response.json().context("invalid remote bridge JSON-RPC response")?;
        if let Some(error) = payload.get("error") {
            bail!("remote bridge error: {}", error);
        }

        let text = payload
            .get("result")
            .and_then(|result| result.get("content"))
            .and_then(Value::as_array)
            .and_then(|content| content.first())
            .and_then(|entry| entry.get("text"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("remote bridge did not return tool content"))?;

        serde_json::from_str(text).with_context(|| format!("remote bridge returned invalid JSON payload for {name}"))
    }
}

fn parse_source(source: &str) -> ActivitySource {
    match source {
        "mcp" => ActivitySource::Mcp,
        "agent" => ActivitySource::Agent,
        "desktop" => ActivitySource::Desktop,
        "human" => ActivitySource::Human,
        "system" => ActivitySource::System,
        _ => ActivitySource::Cli,
    }
}

fn into_phase_input(phase: PlanPhasePayload) -> Result<PlanSyncPhaseInput> {
    Ok(PlanSyncPhaseInput {
        id: phase.id,
        title: phase.title,
        steps: phase.steps.into_iter().map(into_step_input).collect::<Result<Vec<_>>>()?,
    })
}

fn into_step_input(step: PlanStepPayload) -> Result<PlanSyncStepInput> {
    Ok(PlanSyncStepInput {
        id: step.id,
        title: step.title,
        summary: step.summary,
        details: step.details,
        depends_on: step.depends_on,
        subtasks: match step.subtasks {
            Some(subtasks) => Some(subtasks.into_iter().map(into_subtask_input).collect::<Result<Vec<_>>>()?),
            None => None,
        },
    })
}

fn into_subtask_input(subtask: PlanSubtaskPayload) -> Result<PlanSyncSubtaskInput> {
    let status = match subtask.status.as_deref() {
        Some("todo") | None => Some(SubtaskStatus::Todo),
        Some("done") => Some(SubtaskStatus::Done),
        Some(other) => bail!("unsupported subtask status {other}"),
    };
    Ok(PlanSyncSubtaskInput {
        id: subtask.id,
        title: subtask.title,
        status,
    })
}

fn default_mcp_actor() -> String {
    "mcp-agent".to_string()
}

fn default_mcp_source() -> String {
    "mcp".to_string()
}

fn schema_for_value<T: JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T).schema).expect("schema serialization should succeed")
}

fn tool_definitions() -> Vec<ToolDescriptor> {
    vec![
        ToolDescriptor {
            name: "list_projects",
            title: "List projects",
            description: "List initialized and uninitialized projects under watched roots.",
            input_schema: schema_for_value::<ListProjectsArgs>(),
        },
        ToolDescriptor {
            name: "get_project",
            title: "Get project",
            description: "Return manifest, canonical plan, runtime focus, sessions, recent activity, blockers, pending proposals, and handoff text for a project.",
            input_schema: schema_for_value::<GetProjectArgs>(),
        },
        ToolDescriptor {
            name: "sync_plan",
            title: "Sync plan",
            description: "Replace the canonical ordered project plan with the supplied phased plan.",
            input_schema: schema_for_value::<SyncPlanArgs>(),
        },
        ToolDescriptor {
            name: "ensure_session",
            title: "Ensure session",
            description: "Create or resume a workflow session for later step and activity writes.",
            input_schema: schema_for_value::<EnsureSessionArgs>(),
        },
        ToolDescriptor {
            name: "update_runtime",
            title: "Update runtime",
            description: "Merge a validated runtime patch into the project runtime state.",
            input_schema: schema_for_value::<UpdateRuntimeArgs>(),
        },
        ToolDescriptor {
            name: "append_activity",
            title: "Append activity",
            description: "Append a structured activity event, optionally linked to a session, step, or subtask.",
            input_schema: schema_for_value::<AppendActivityArgs>(),
        },
        ToolDescriptor {
            name: "start_step",
            title: "Start step",
            description: "Move a step into in-progress state and claim ownership for a session.",
            input_schema: schema_for_value::<StepMutationArgs>(),
        },
        ToolDescriptor {
            name: "complete_step",
            title: "Complete step",
            description: "Mark a step done and advance runtime focus to the next actionable step.",
            input_schema: schema_for_value::<StepMutationArgs>(),
        },
        ToolDescriptor {
            name: "set_blocker",
            title: "Set blocker",
            description: "Add or clear a blocker on the current runtime state.",
            input_schema: schema_for_value::<SetBlockerArgs>(),
        },
        ToolDescriptor {
            name: "refresh_handoff",
            title: "Refresh handoff",
            description: "Regenerate the handoff snapshot for a project.",
            input_schema: schema_for_value::<RefreshHandoffArgs>(),
        },
        ToolDescriptor {
            name: "propose_decision",
            title: "Propose decision",
            description: "Create a pending decision proposal for later human acceptance.",
            input_schema: schema_for_value::<ProposeDecisionArgs>(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use parallel_workflow_core::InitProjectInput;
    use std::{fs, net::TcpListener, time::Duration};

    fn create_index_db() -> Result<String> {
        let dir = tempfile::tempdir()?;
        Ok(dir.keep().join("workflow-index.sqlite").display().to_string())
    }

    fn create_repo() -> Result<String> {
        let dir = tempfile::tempdir()?;
        let root = dir.keep().join("bridge-project");
        fs::create_dir_all(root.join(".git"))?;
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/main\n")?;
        Ok(root.display().to_string())
    }

    async fn spawn_server(config: ServeHttpConfig) -> Result<(u16, tokio::task::JoinHandle<Result<()>>)> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        drop(listener);
        let handle = tokio::spawn(run_serve_http(ServeHttpConfig { port, ..config }));
        tokio::time::sleep(Duration::from_millis(120)).await;
        Ok((port, handle))
    }

    #[tokio::test]
    async fn health_requires_valid_bearer_token() -> Result<()> {
        let index_db = create_index_db()?;
        let (port, handle) = spawn_server(ServeHttpConfig {
            port: 0,
            token: "secret".to_string(),
            watched_roots: Vec::new(),
            index_db_path: index_db,
        })
        .await?;

        let client = reqwest::Client::new();
        let unauthorized = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .await?;
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let authorized = client
            .get(format!("http://127.0.0.1:{port}/health"))
            .header("Authorization", "Bearer secret")
            .send()
            .await?;
        assert_eq!(authorized.status(), StatusCode::OK);

        handle.abort();
        Ok(())
    }

    #[tokio::test]
    async fn tools_list_contains_existing_surface() -> Result<()> {
        let index_db = create_index_db()?;
        let (port, handle) = spawn_server(ServeHttpConfig {
            port: 0,
            token: "secret".to_string(),
            watched_roots: Vec::new(),
            index_db_path: index_db,
        })
        .await?;

        let client = reqwest::Client::new();
        let response: Value = client
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header("Authorization", "Bearer secret")
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/list",
                "params": {}
            }))
            .send()
            .await?
            .json()
            .await?;

        let names = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(names.contains(&"list_projects"));
        assert!(names.contains(&"complete_step"));
        assert!(names.contains(&"propose_decision"));

        handle.abort();
        Ok(())
    }

    #[tokio::test]
    async fn tool_calls_return_existing_payload_shape() -> Result<()> {
        let repo = create_repo()?;
        let index_db = std::path::Path::new(&repo).join(".app/index.sqlite").display().to_string();
        parallel_workflow_core::init_project(InitProjectInput {
            root: repo.clone(),
            actor: "tester".to_string(),
            source: ActivitySource::Cli,
            name: Some("Bridge".to_string()),
            kind: Some("software".to_string()),
            owner: Some("tester".to_string()),
            tags: Some(Vec::new()),
            index_db_path: index_db.clone(),
        })?;

        let (port, handle) = spawn_server(ServeHttpConfig {
            port: 0,
            token: "secret".to_string(),
            watched_roots: vec![repo.clone()],
            index_db_path: index_db,
        })
        .await?;

        let client = reqwest::Client::new();
        let response: Value = client
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header("Authorization", "Bearer secret")
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "get_project",
                    "arguments": {
                        "root": repo
                    }
                }
            }))
            .send()
            .await?
            .json()
            .await?;

        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text)?;
        assert_eq!(payload["manifest"]["name"], "Bridge");

        handle.abort();
        Ok(())
    }
}
