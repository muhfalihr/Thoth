use serde::{Deserialize, Serialize};

pub mod main_footage;

/// One machine-readable progress record on the worker's stdout (NDJSON).
/// job_id and event `type` are added by the server, not the worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressEvent {
    pub stage: String,
    pub pct: f32,
    pub message: String,
    pub ts: String,
}

#[cfg(test)]
mod main_footage_contract_tests {
    use serde_json::{Value, json};

    use crate::main_footage::SourcePackageV1;

    fn source_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../tests/fixtures/main-footage/contracts/source-package.v1.json"
        ))
        .unwrap()
    }

    #[test]
    fn shared_source_package_decoder_rejects_invalid_nested_scenes_and_duplicate_ids() {
        let mut invalid_scene = source_fixture();
        invalid_scene["scene_indexes"][0]["scenes"][0]["end_sec"] = json!(0.0);
        assert!(serde_json::from_value::<SourcePackageV1>(invalid_scene).is_err());

        let mut duplicate_sources = source_fixture();
        let duplicate = duplicate_sources["sources"][0].clone();
        duplicate_sources["sources"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(serde_json::from_value::<SourcePackageV1>(duplicate_sources).is_err());
    }
}
