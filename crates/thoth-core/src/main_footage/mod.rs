pub mod contracts;
pub mod paths;

pub use contracts::{
    fingerprint_canonical, MainFootageDescriptor, MainFootageErrorCode, MainFootageMode,
    MainFootagePlanV1, MainFootageWarningCode, NarrationTimelineV1, SourcePackageV1,
    TransitionKind,
};
pub use paths::{import_file, resolve_contained};

#[cfg(test)]
mod reexport_tests {
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
}
