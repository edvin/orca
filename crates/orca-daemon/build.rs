//! Embeds Orca's documentation (the website's docs pages, and the ones kept
//! in the repo's docs/ folder) so AI tools can read the docs that match the
//! running Orca, without web access. See src/docs.rs.

use std::fmt::Write;
use std::path::Path;

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let site = root.join("site/content/docs");
    println!("cargo:rerun-if-changed={}", site.display());
    let mut files: Vec<(String, std::path::PathBuf)> = std::fs::read_dir(&site)
        .map(|d| {
            d.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "md"))
                .map(|p| (p.file_stem().unwrap().to_string_lossy().to_string(), p))
                .collect()
        })
        .unwrap_or_default();
    for shared in ["orca-yaml", "profiles"] {
        let p = root.join("docs").join(format!("{shared}.md"));
        println!("cargo:rerun-if-changed={}", p.display());
        if p.exists() {
            files.push((shared.to_string(), p));
        }
    }
    files.sort();
    let mut out = String::from("pub static DOCS: &[(&str, &str)] = &[\n");
    for (slug, path) in files {
        let path = path.canonicalize().unwrap();
        writeln!(out, "    ({slug:?}, include_str!({:?})),", path.display().to_string()).unwrap();
    }
    out.push_str("];\n");
    std::fs::write(Path::new(&std::env::var("OUT_DIR").unwrap()).join("docs.rs"), out).unwrap();
}
