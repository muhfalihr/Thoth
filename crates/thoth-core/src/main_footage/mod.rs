pub mod contracts;
pub mod coordinator;
pub mod import;
pub mod paths;
pub mod verify;

use std::fmt;

pub use contracts::{
    MainFootageDescriptor, MainFootageErrorCode, MainFootageMode, MainFootagePlanV1,
    MainFootageWarningCode, NarrationBeatV1, NarrationTimelineV1, NarrationWordV1, PlanningMode,
    SourcePackageV1, TransitionKind, fingerprint_canonical,
};
pub use coordinator::{MainFootageCoordinator, MainFootagePrepareInput};
pub use import::{ImportedSourcePackage, import_package};
pub use paths::{import_file, resolve_contained, write_immutable};
pub use verify::{MainFootagePlanMetrics, VerifiedMainFootagePlan, verify_plan};

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

/// Forced main-footage runs allocate footage against narration beats, so a
/// runtime config with the narrator switched off cannot produce a plan at all.
/// Legacy runs are unaffected — this is only consulted on the forced path.
pub fn require_narration_enabled(narration_enabled: bool) -> Result<(), MainFootageError> {
    if narration_enabled {
        Ok(())
    } else {
        Err(MainFootageError::new(
            MainFootageErrorCode::ForcedMainNarrationRequired,
            "narration_disabled_in_runtime_config",
        ))
    }
}

/// What a failed narration stage means for this run: nothing in legacy mode,
/// where the pipeline logs a warning and continues without a narrator, and a
/// terminal `narration_generation_failed` in forced mode. The underlying error
/// is deliberately not carried into `detail` — it can hold a raw model response.
pub fn narration_failure(forced: bool) -> Option<MainFootageError> {
    forced.then(|| {
        MainFootageError::new(
            MainFootageErrorCode::NarrationGenerationFailed,
            "narration_stage_failed",
        )
    })
}

#[cfg(test)]
mod reexport_tests {
    use super::{
        MainFootageCoordinator, MainFootageError, MainFootageErrorCode, MainFootagePlanMetrics,
        MainFootagePrepareInput, VerifiedMainFootagePlan, narration_failure,
        require_narration_enabled, verify_plan,
    };

    #[test]
    fn planned_mode_interfaces_are_exported_from_the_domain_root() {
        assert!(std::any::type_name::<MainFootageCoordinator>().contains("MainFootageCoordinator"));
        assert!(
            std::any::type_name::<MainFootagePrepareInput<'static>>()
                .contains("MainFootagePrepareInput")
        );
        assert!(
            std::any::type_name::<VerifiedMainFootagePlan>().contains("VerifiedMainFootagePlan")
        );
        assert!(std::any::type_name::<MainFootagePlanMetrics>().contains("MainFootagePlanMetrics"));
        let _verify_entrypoint = verify_plan;
    }

    /// A forced run has nothing for the cut planner to allocate against without
    /// narration beats, so a disabled narrator is a hard stop. Legacy runs are
    /// free to disable it — this gate is only consulted on the forced path.
    #[test]
    fn forced_mode_requires_narration_to_be_enabled() {
        assert!(require_narration_enabled(true).is_ok());
        assert_eq!(
            require_narration_enabled(false).unwrap_err().code,
            MainFootageErrorCode::ForcedMainNarrationRequired
        );
    }

    /// Pins the split the brief asks for: the legacy pipeline keeps its
    /// best-effort warning and continues without a narrator, while the same
    /// failure ends a forced run.
    #[test]
    fn legacy_narration_failure_continues_but_forced_is_terminal() {
        assert!(narration_failure(false).is_none());
        assert_eq!(
            narration_failure(true).unwrap().code,
            MainFootageErrorCode::NarrationGenerationFailed
        );
    }

    #[test]
    fn core_reexports_the_leaf_main_footage_contract() {
        let descriptor: crate::main_footage::MainFootageDescriptor =
            serde_json::from_value(serde_json::json!({
                "mode": "forced_url_pool",
                "package_manifest": "packages/source-package.json",
                "coverage_target": 0.6
            }))
            .unwrap();
        let leaf: thoth_types::main_footage::MainFootageDescriptor = descriptor;
        assert_eq!(
            leaf.mode,
            thoth_types::main_footage::MainFootageMode::ForcedUrlPool
        );
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
