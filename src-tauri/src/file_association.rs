//! Selective Windows file-association removal that preserves foreign values.
use crate::commands::reg_err;
use crate::errors::AppError;

#[cfg(any(target_os = "windows", test))]
pub(crate) trait AssociationRegistry {
    fn get_string(&self, path: &str, name: &str) -> std::io::Result<String>;
    fn delete_subkey_all(&self, path: &str) -> std::io::Result<()>;
    fn delete_value(&self, path: &str, name: &str) -> std::io::Result<()>;
}

#[cfg(target_os = "windows")]
struct WinAssociationRegistry;

#[cfg(target_os = "windows")]
impl AssociationRegistry for WinAssociationRegistry {
    fn get_string(&self, path: &str, name: &str) -> std::io::Result<String> {
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey(path)?
            .get_value(name)
    }

    fn delete_subkey_all(&self, path: &str) -> std::io::Result<()> {
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).delete_subkey_all(path)
    }

    fn delete_value(&self, path: &str, name: &str) -> std::io::Result<()> {
        winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey_with_flags(path, winreg::enums::KEY_SET_VALUE)?
            .delete_value(name)
    }
}

#[cfg(any(target_os = "windows", test))]
fn ignore_missing(result: std::io::Result<()>) -> Result<(), AppError> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(reg_err(error)),
    }
}

#[cfg(any(target_os = "windows", test))]
fn unregister_with(registry: &impl AssociationRegistry, extension: &str) -> Result<(), AppError> {
    let prog_id = format!("PSForge{}", extension.replace('.', "_"));
    ignore_missing(registry.delete_subkey_all(&format!(r"Software\Classes\{}", prog_id)))?;

    let ext_path = format!(r"Software\Classes\{}", extension);
    match registry.get_string(&ext_path, "") {
        Ok(current) if current == prog_id => {
            ignore_missing(registry.delete_value(&ext_path, ""))?;
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(reg_err(error)),
    }

    ignore_missing(registry.delete_value(
        &format!(r"Software\Classes\{}\OpenWithProgids", extension),
        &prog_id,
    ))
}

#[cfg(target_os = "windows")]
pub(crate) fn unregister(extension: &str) -> Result<(), AppError> {
    unregister_with(&WinAssociationRegistry, extension)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeRegistry {
        current_default: Option<String>,
        fail_delete: bool,
        operations: std::cell::RefCell<Vec<String>>,
    }

    impl AssociationRegistry for FakeRegistry {
        fn get_string(&self, path: &str, _name: &str) -> std::io::Result<String> {
            self.current_default.clone().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("no default value at {path}"),
                )
            })
        }

        fn delete_subkey_all(&self, path: &str) -> std::io::Result<()> {
            self.operations
                .borrow_mut()
                .push(format!("delete_tree:{path}"));
            if self.fail_delete {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected delete failure",
                ))
            } else {
                Ok(())
            }
        }

        fn delete_value(&self, path: &str, name: &str) -> std::io::Result<()> {
            self.operations
                .borrow_mut()
                .push(format!("delete_value:{path}:{name}"));
            if self.fail_delete {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected delete failure",
                ))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn removes_only_psforge_values_and_default() {
        let registry = FakeRegistry {
            current_default: Some("PSForge_ps1".to_string()),
            ..FakeRegistry::default()
        };
        unregister_with(&registry, ".ps1").expect("isolated unregister");
        assert_eq!(
            registry.operations.borrow().as_slice(),
            [
                r"delete_tree:Software\Classes\PSForge_ps1",
                r"delete_value:Software\Classes\.ps1:",
                r"delete_value:Software\Classes\.ps1\OpenWithProgids:PSForge_ps1",
            ]
        );
    }

    #[test]
    fn preserves_foreign_default_and_propagates_delete_errors() {
        let registry = FakeRegistry {
            current_default: Some("OtherApp_ps1".to_string()),
            ..FakeRegistry::default()
        };
        unregister_with(&registry, ".ps1").expect("isolated unregister");
        assert_eq!(
            registry.operations.borrow().as_slice(),
            [
                r"delete_tree:Software\Classes\PSForge_ps1",
                r"delete_value:Software\Classes\.ps1\OpenWithProgids:PSForge_ps1",
            ]
        );

        let failing = FakeRegistry {
            current_default: Some("PSForge_ps1".to_string()),
            fail_delete: true,
            ..FakeRegistry::default()
        };
        let error =
            unregister_with(&failing, ".ps1").expect_err("deletion failures must reach the caller");
        assert_eq!(error.code, "REGISTRY_ERROR");
    }
}
