//! Native enumeration for Open Folder, without exposing the frontend filesystem API.
use crate::errors::AppError;
use crate::utils::run_blocking;
use std::path::{Path, PathBuf};

#[cfg_attr(not(test), tauri::command)]
pub async fn list_script_files(directory: String) -> Result<Vec<String>, AppError> {
    run_blocking("list_script_files", move || {
        list_script_files_blocking(Path::new(&directory))
    })
    .await
}

fn list_script_files_blocking(directory: &Path) -> Result<Vec<String>, AppError> {
    let root = directory.canonicalize().map_err(|error| AppError {
        code: "SCRIPT_FOLDER_UNREADABLE".to_string(),
        message: format!("Cannot open selected folder: {error}"),
    })?;
    if !root.is_dir() {
        return Err(AppError {
            code: "SCRIPT_FOLDER_NOT_DIRECTORY".to_string(),
            message: "The selected path is not a folder.".to_string(),
        });
    }

    let mut scripts = Vec::<PathBuf>::new();
    for entry in std::fs::read_dir(&root)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() || !is_powershell_script(&entry.path()) {
            continue;
        }
        scripts.push(entry.path());
    }
    scripts.sort_by_key(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    });
    scripts
        .into_iter()
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map(|path| path.replace('\\', "/"))
                .map_err(|_| AppError {
                    code: "SCRIPT_FOLDER_NON_UNICODE_PATH".to_string(),
                    message: "A script path in the selected folder is not valid Unicode."
                        .to_string(),
                })
        })
        .collect()
}

fn is_powershell_script(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("ps1")
                || extension.eq_ignore_ascii_case("psm1")
                || extension.eq_ignore_ascii_case("psd1")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "psforge-script-folder-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).unwrap();
        directory
    }

    #[test]
    fn lists_only_direct_scripts_with_case_insensitive_extensions_and_sorting() {
        let directory = test_directory("filter");
        for name in ["b.PS1", "a.psm1", "c.psd1", "ignore.txt"] {
            std::fs::write(directory.join(name), "").unwrap();
        }
        std::fs::create_dir(directory.join("nested.ps1")).unwrap();

        let scripts = list_script_files_blocking(&directory).unwrap();
        let names = scripts
            .iter()
            .map(|path| Path::new(path).file_name().unwrap().to_string_lossy())
            .collect::<Vec<_>>();
        assert_eq!(names, ["a.psm1", "b.PS1", "c.psd1"]);

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_a_file_instead_of_enumerating_its_parent() {
        let directory = test_directory("not-directory");
        let file = directory.join("script.ps1");
        std::fs::write(&file, "").unwrap();

        let error = list_script_files_blocking(&file).unwrap_err();
        assert_eq!(error.code, "SCRIPT_FOLDER_NOT_DIRECTORY");

        std::fs::remove_dir_all(directory).unwrap();
    }
}
