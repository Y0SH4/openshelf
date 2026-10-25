use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub message: String,
}

pub async fn health_check() -> Json<HealthResponse> {
    let response = HealthResponse {
        status: "oke".to_string(),
        version: "0.1.0".to_string(),
        message: "OpenShelf API is Helath!".to_string(),
    };

    Json(response)
}
