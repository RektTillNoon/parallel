use crate::models::AcceptedDecision;

pub fn build_accepted_decision_markdown(entries: &[AcceptedDecision]) -> String {
    let mut lines = vec!["# Accepted Decisions".to_string(), String::new()];
    for entry in entries {
        lines.push(format!("## {} - {}", entry.date, entry.title));
        lines.push(String::new());
        lines.push("### Context".to_string());
        lines.push(if entry.context.is_empty() {
            "_No context provided._".to_string()
        } else {
            entry.context.clone()
        });
        lines.push(String::new());
        lines.push("### Decision".to_string());
        lines.push(if entry.decision.is_empty() {
            "_No decision text provided._".to_string()
        } else {
            entry.decision.clone()
        });
        lines.push(String::new());
        lines.push("### Impact".to_string());
        lines.push(if entry.impact.is_empty() {
            "_No impact recorded._".to_string()
        } else {
            entry.impact.clone()
        });
        lines.push(String::new());
    }
    format!("{}\n", lines.join("\n").trim_end())
}

pub fn parse_accepted_decisions(markdown: &str) -> Vec<AcceptedDecision> {
    let normalized = markdown.trim_start_matches("# Accepted Decisions").trim();
    if normalized.is_empty() {
        return Vec::new();
    }

    normalized
        .split("\n## ")
        .map(|chunk| chunk.trim_start_matches("## ").trim())
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| {
            let mut lines = chunk.lines();
            let heading = lines.next().unwrap_or_default();
            let mut heading_parts = heading.splitn(2, " - ");
            let date = heading_parts.next().unwrap_or_default().trim().to_string();
            let title = heading_parts.next().unwrap_or_default().trim().to_string();
            let body = lines.collect::<Vec<_>>().join("\n");

            fn section(body: &str, label: &str) -> String {
                let marker = format!("### {label}");
                let Some(start) = body.find(&marker) else {
                    return String::new();
                };
                let after = &body[start + marker.len()..];
                let after = after.trim_start_matches('\n');
                let end = after.find("\n### ").unwrap_or(after.len());
                after[..end].trim().to_string()
            }

            AcceptedDecision {
                date,
                title,
                context: section(&body, "Context"),
                decision: section(&body, "Decision"),
                impact: section(&body, "Impact"),
            }
        })
        .collect()
}
