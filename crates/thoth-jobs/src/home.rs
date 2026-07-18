use std::{
    env,
    io::{self, ErrorKind},
    path::{Path, PathBuf},
};

/// Directories owned by a single Thoth installation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThothHome {
    root: PathBuf,
}

impl ThothHome {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn data_dir(&self) -> PathBuf {
        self.root.join("data")
    }

    pub fn project_root(&self, id: &str) -> PathBuf {
        self.root.join("projects").join(id)
    }

    pub fn project_outputs(&self, id: &str) -> PathBuf {
        self.project_root(id).join("outputs")
    }

    /// Creates the shared directories that Thoth owns below its application home.
    pub fn ensure_layout(&self) -> io::Result<()> {
        for directory in [
            self.data_dir(),
            self.root.join("projects"),
            self.root.join("cache"),
            self.root.join("logs"),
        ] {
            std::fs::create_dir_all(directory)?;
        }
        Ok(())
    }

    /// Creates the directories owned by one project workspace.
    pub fn ensure_project_layout(&self, id: &str) -> io::Result<()> {
        self.ensure_layout()?;
        let project_root = self.project_root(id);
        for directory in [
            project_root.join("content-sets"),
            project_root.join("sources"),
            project_root.join("outputs"),
        ] {
            std::fs::create_dir_all(directory)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn for_test(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }
}

/// Resolves the Thoth application home with explicit CLI input taking precedence.
pub fn resolve_home(explicit: Option<&Path>) -> io::Result<ThothHome> {
    let environment_home = env::var_os("THOTH_HOME").map(PathBuf::from);
    resolve_home_from_environment(explicit, environment_home.as_deref())
}

fn resolve_home_from_environment(
    explicit: Option<&Path>,
    environment_home: Option<&Path>,
) -> io::Result<ThothHome> {
    let root = explicit
        .map(Path::to_path_buf)
        .or_else(|| environment_home.map(Path::to_path_buf))
        .unwrap_or(default_home()?.join(".thoth"));

    Ok(ThothHome { root })
}

fn default_home() -> io::Result<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            io::Error::new(
                ErrorKind::NotFound,
                "could not determine the user home directory",
            )
        })
}

#[cfg(test)]
pub(crate) fn resolve_home_with_env(
    explicit: Option<&Path>,
    environment_home: Option<&Path>,
) -> io::Result<ThothHome> {
    resolve_home_from_environment(explicit, environment_home)
}
