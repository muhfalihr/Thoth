pub mod contracts;
pub mod import;
pub mod paths;

use std::fmt;

pub use contracts::{
    fingerprint_canonical, MainFootageDescriptor, MainFootageErrorCode, MainFootageMode,
    MainFootagePlanV1, MainFootageWarningCode, NarrationTimelineV1, PlanningMode, SourcePackageV1,
    TransitionKind,
};
pub use import::{import_package, ImportedSourcePackage};
pub use paths::{import_file, resolve_contained, write_immutable};

/// A forced main-footage failure carrying the wire error code the CLI, worker,
/// and REST surface all report. `detail` is a short stable reason — never a
/// credential, a signed URL, or an absolute path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MainFootageError {
    pub code: MainFootageErrorCode,
    pub detail: String,
}

impl MainFootageError {
    pub fn new(code: MainFootageErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    /// The snake_case wire spelling, taken straight from the contract enum so it
    /// can never drift from what `thoth-server` emits.
    pub fn code_str(&self) -> String {
        serde_json::to_string(&self.code)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string()
    }
}

impl fmt::Display for MainFootageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code_str(), self.detail)
    }
}

impl std::error::Error for MainFootageError {}

#[cfg(test)]
mod reexport_tests {
    use super::{MainFootageError, MainFootageErrorCode};

    #[test]
    fn core_reexports_the_leaf_main_footage_contract() {
        let descriptor: crate::main_footage::MainFootageDescriptor = serde_json::from_value(
            serde_json::json!({
                "mode": "forced_url_pool",
                "package_manifest": "packages/source-package.json",
                "coverage_target": 0.6
            }),
        )
        .unwrap();
        let leaf: thoth_types::main_footage::MainFootageDescriptor = descriptor;
        assert_eq!(leaf.mode, thoth_types::main_footage::MainFootageMode::ForcedUrlPool);
    }

    /// The codes the core reports must spell exactly what `thoth-server`'s
    /// routes already emit and its HTTP tests already assert on.
    #[test]
    fn error_codes_match_the_published_wire_spellings() {
        for (code, wire) in [
            (
                MainFootageErrorCode::SourcePackageInvalid,
                "source_package_invalid",
            ),
            (
                MainFootageErrorCode::ForcedMainNarrationRequired,
                "forced_main_narration_required",
            ),
            (
                MainFootageErrorCode::NarrationGenerationFailed,
                "narration_generation_failed",
            ),
        ] {
            assert_eq!(MainFootageError::new(code, "detail").code_str(), wire);
        }
    }
}
