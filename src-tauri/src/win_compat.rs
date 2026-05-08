/// Cross-platform polyfill for `std::os::windows::process::CommandExt::creation_flags`.
/// On non-Windows targets, the trait method is a no-op so the rest of the codebase
/// can call `.creation_flags(...)` unconditionally.
#[cfg(not(windows))]
pub trait CommandExt {
    fn creation_flags(&mut self, flags: u32) -> &mut Self;
}

#[cfg(not(windows))]
impl CommandExt for std::process::Command {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self {
        self
    }
}

#[cfg(not(windows))]
impl CommandExt for tokio::process::Command {
    fn creation_flags(&mut self, _flags: u32) -> &mut Self {
        self
    }
}
