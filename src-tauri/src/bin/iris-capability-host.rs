use iris_desktop_lib::capability_foundry::{mcp, storage};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1)
    }
}

async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut package_id = None;
    while let Some(arg) = args.next() {
        if arg == "--package" {
            package_id = args.next();
        } else {
            return Err("Usage: iris-capability-host --package <package-id>".to_string());
        }
    }
    let root = test_registry_root().unwrap_or(storage::default_root()?);
    let package_id = package_id.ok_or_else(|| "Package id is required".to_string())?;
    let package = mcp::package_for_host(&root, &package_id)?;
    mcp::serve_stdio(&root, &package).await
}

fn test_registry_root() -> Option<std::path::PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let root = std::env::var_os("IRIS_CAPABILITY_TEST_ROOT").map(std::path::PathBuf::from)?;
    root.join(".iris-foundry-test-registry")
        .is_file()
        .then_some(root)
}
