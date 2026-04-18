pub mod agent_defaults;

pub use agent_defaults::{
    apply_agent_defaults, build_client_snippet, inspect_agent_defaults,
    stable_projectctl_install_path, AgentDefaultsContext, AgentScopeStatus,
    AgentTargetStatus, BridgeSnippet, ClientKind, InstallAction, InstallScope, InstallStatus,
};
