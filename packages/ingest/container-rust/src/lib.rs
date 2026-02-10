extern crate self as usc_ingest;

pub mod ingest;
pub mod runtime;
pub mod sources;
pub mod types;
pub mod xmlspec;

pub use xmlspec_macros::xmlspec;
