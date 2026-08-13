use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

fn invalid_path(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn is_remote_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let Some((scheme, rest)) = text.split_once("://") else {
        return false;
    };
    !scheme.is_empty()
        && scheme.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
        && !rest.is_empty()
}

/// Resolves a slash-separated artifact path only when it remains inside `root`.
///
/// Both root and the destination's existing parent are canonicalized before the
/// returned path is used, preventing a symlink from escaping a job package.
pub fn resolve_contained(root: &Path, relative: &Path) -> io::Result<PathBuf> {
    let relative_text = relative.to_string_lossy();
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || is_remote_path(relative)
        || relative_text.contains('\\')
    {
        return Err(invalid_path("artifact_path_must_be_relative"));
    }
    if relative
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(invalid_path("path_outside_root"));
    }

    let root = fs::canonicalize(root)?;
    let candidate = root.join(relative);
    let filename = candidate
        .file_name()
        .ok_or_else(|| invalid_path("artifact_path_must_be_relative"))?;
    let parent = candidate
        .parent()
        .ok_or_else(|| invalid_path("artifact_path_must_be_relative"))?;
    let parent = fs::canonicalize(parent)?;
    let resolved = parent.join(filename);
    if resolved == root || !resolved.starts_with(&root) {
        return Err(invalid_path("path_outside_root"));
    }
    Ok(resolved)
}

/// Atomically publishes a temporary sibling without replacing an existing artifact.
fn publish_immutable(temporary: &Path, destination: &Path) -> io::Result<()> {
    match fs::hard_link(temporary, destination) {
        Ok(()) => {
            fs::remove_file(temporary)?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "destination_exists",
        )),
        Err(error) => Err(error),
    }
}

/// Imports an immutable source using a hardlink when possible, with a copy
/// fallback. The completed artifact becomes visible only after an atomic no-replace publish.
pub fn import_file(source: &Path, destination: &Path) -> io::Result<()> {
    let source = fs::canonicalize(source)?;
    let parent = destination
        .parent()
        .ok_or_else(|| invalid_path("destination has no parent"))?;
    fs::create_dir_all(parent)?;
    let parent = fs::canonicalize(parent)?;
    let filename = destination
        .file_name()
        .ok_or_else(|| invalid_path("destination has no filename"))?;
    let destination = parent.join(filename);
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        filename.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    match fs::hard_link(&source, &temporary) {
        Ok(()) => {}
        Err(_) => {
            fs::copy(&source, &temporary)?;
        }
    }
    if let Err(error) = publish_immutable(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::{import_file, publish_immutable, resolve_contained};

    #[test]
    fn rejects_remote_artifact_paths_before_filesystem_access() {
        assert!(resolve_contained(Path::new("job"), Path::new("https://cdn.test/a.mp4")).is_err());
    }

    #[test]
    fn immutable_publish_never_replaces_an_existing_destination() {
        let root =
            std::env::temp_dir().join(format!("main-footage-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let temporary = root.join("cut.tmp");
        let destination = root.join("cuts/cut.mp4");
        fs::write(&temporary, b"new bytes").unwrap();
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(&destination, b"existing bytes").unwrap();

        assert!(publish_immutable(&temporary, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing bytes");
        assert_eq!(fs::read(&temporary).unwrap(), b"new bytes");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_file_publishes_complete_source_bytes() {
        let root =
            std::env::temp_dir().join(format!("main-footage-import-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.mp4");
        let destination = root.join("cuts/v001/cut.mp4");
        fs::write(&source, b"complete immutable source bytes").unwrap();

        import_file(&source, &destination).unwrap();
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"complete immutable source bytes"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
