use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiQuery {
    pub query: String,
    pub context: Option<AiContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiContext {
    pub container_id: Option<String>,
    pub container_name: Option<String>,
    pub container_logs: Option<String>,
    pub exit_code: Option<i64>,
    pub error: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResponse {
    pub answer: String,
    pub suggestions: Vec<AiSuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSuggestion {
    pub label: String,
    pub action: String,
    pub detail: String,
}
