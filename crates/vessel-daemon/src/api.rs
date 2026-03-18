use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    routing::get,
};
use serde::Serialize;

use crate::state::AppState;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/health", get(health))
        .route("/machines", get(list_machines))
        .route("/containers", get(list_containers))
        .route("/images", get(list_images))
        .route("/volumes", get(list_volumes))
        .route("/networks", get(list_networks))
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

// Placeholder handlers — these will call into the runtime traits.

async fn list_machines(State(_state): State<Arc<AppState>>) -> Json<Vec<()>> {
    Json(vec![])
}

async fn list_containers(State(_state): State<Arc<AppState>>) -> Json<Vec<()>> {
    Json(vec![])
}

async fn list_images(State(_state): State<Arc<AppState>>) -> Json<Vec<()>> {
    Json(vec![])
}

async fn list_volumes(State(_state): State<Arc<AppState>>) -> Json<Vec<()>> {
    Json(vec![])
}

async fn list_networks(State(_state): State<Arc<AppState>>) -> Json<Vec<()>> {
    Json(vec![])
}
