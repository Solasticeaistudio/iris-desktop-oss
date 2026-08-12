use iris_desktop_lib::capability_foundry::discovery;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::AtomicBool;

#[tokio::test]
async fn bounded_discovery_detects_static_html_form_graphql_and_jsonld_surfaces() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        for _ in 0..10 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let count = stream.read(&mut buffer).unwrap();
            let first = String::from_utf8_lossy(&buffer[..count])
                .lines()
                .next()
                .unwrap_or("")
                .to_string();
            let path = first.split_whitespace().nth(1).unwrap_or("/");
            let (status, content_type, body) = match path {
                "/sitemap.xml" => (200, "application/xml", "<urlset></urlset>"),
                "/robots.txt" => (200, "text/plain", "User-agent: *"),
                "/llms.txt" => (200, "text/plain", "Capability information"),
                "/" => (200, "text/html", "<html><script type='application/ld+json'>{}</script><p>GraphQL endpoint</p><form action='/search' method='get'><input name='q'></form></html>"),
                _ => (404, "text/plain", "not found"),
            };
            write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    let cancel = AtomicBool::new(false);
    let target = format!("http://127.0.0.1:{port}/");
    let mut grant = discovery::inspect_target(&target).await.unwrap();
    discovery::authorize_local_grant(&mut grant, true).unwrap();
    let result = discovery::discover(&target, &mut grant, &cancel)
        .await
        .unwrap();
    server.join().unwrap();
    for surface in [
        "sitemap",
        "robots",
        "llms.txt",
        "json-ld",
        "graphql-candidate",
        "html",
        "forms",
    ] {
        assert!(
            result.detected_surfaces.contains(&surface.to_string()),
            "missing {surface:?}: {:?}",
            result.detected_surfaces
        );
    }
    assert_eq!(result.requests_made, 10);
    let package = result.package.expect("form candidate");
    assert_eq!(package.target_origin, format!("http://127.0.0.1:{port}"));
    assert_eq!(
        package.network_scope.approved_addresses,
        vec!["127.0.0.1".to_string()]
    );
}

#[tokio::test]
async fn local_grant_does_not_authorize_cross_origin_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        for _ in 0..10 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer).unwrap();
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: https://attacker.example/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        }
    });
    let target = format!("http://127.0.0.1:{port}/");
    let mut grant = discovery::inspect_target(&target).await.unwrap();
    discovery::authorize_local_grant(&mut grant, true).unwrap();
    let cancel = AtomicBool::new(false);
    assert_eq!(
        discovery::discover(&target, &mut grant, &cancel)
            .await
            .unwrap_err(),
        "DISCOVERY_REDIRECT_REQUIRES_SEPARATE_AUTHORIZATION"
    );
    server.join().unwrap();
}
