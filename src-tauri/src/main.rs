// Prevents additional console window on Windows in release
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--capability-host") {
        let package_id = args
            .windows(2)
            .find(|pair| pair[0] == "--package")
            .map(|pair| pair[1].clone());
        let result = package_id
            .ok_or_else(|| "Package id is required".to_string())
            .and_then(|package_id| {
                let root = iris_desktop_lib::capability_foundry::storage::default_root()?;
                let package = iris_desktop_lib::capability_foundry::mcp::package_for_host(
                    &root,
                    &package_id,
                )?;
                tokio::runtime::Runtime::new()
                    .map_err(|error| error.to_string())?
                    .block_on(iris_desktop_lib::capability_foundry::mcp::serve_stdio(
                        &root, &package,
                    ))
            });
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    iris_desktop_lib::run()
}
