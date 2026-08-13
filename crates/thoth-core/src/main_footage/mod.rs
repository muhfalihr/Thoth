pub mod contracts;
pub mod paths;

pub use contracts::{
    fingerprint_canonical, MainFootageDescriptor, MainFootageErrorCode, MainFootageMode,
    MainFootagePlanV1, MainFootageWarningCode, NarrationTimelineV1, SourcePackageV1,
    TransitionKind,
};
pub use paths::{import_file, resolve_contained};
