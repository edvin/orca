//! Orca's own documentation, for AI tools (`orca_docs`): the pages of
//! orca-desktop.com/docs as they were when this Orca was built.

include!(concat!(env!("OUT_DIR"), "/docs.rs"));

/// Titles and descriptions of the pages kept in the repo's docs/ folder,
/// which have no front matter (they're read on GitHub too).
const SHARED: &[(&str, &str, &str)] = &[
    (
        "orca-yaml",
        "orca.yaml reference",
        "Every key of orca.yaml: gateway routes, links, build targets, setup hooks, required databases and worktree instances.",
    ),
    (
        "profiles",
        "Running only the services you need",
        "Use Docker Compose profiles to switch optional services on and off per stack and per worktree.",
    ),
];

pub struct Page {
    pub slug: &'static str,
    pub title: String,
    pub description: String,
    pub body: &'static str,
}

fn page(slug: &'static str, text: &'static str) -> Page {
    if let Some(rest) = text.strip_prefix("---\n")
        && let Some(end) = rest.find("\n---\n")
    {
        let front = &rest[..end];
        let field = |k: &str| {
            front
                .lines()
                .find_map(|l| l.strip_prefix(&format!("{k}:")))
                .map(|v| v.trim().to_string())
                .unwrap_or_default()
        };
        return Page {
            slug,
            title: field("title"),
            description: field("description"),
            body: rest[end + 5..].trim_start(),
        };
    }
    let (title, description) = SHARED
        .iter()
        .find(|(s, _, _)| *s == slug)
        .map(|(_, t, d)| (t.to_string(), d.to_string()))
        .unwrap_or_else(|| (slug.to_string(), String::new()));
    // The shared pages start with their title as a heading.
    let body = text
        .split_once('\n')
        .filter(|(h, _)| h.starts_with("# "))
        .map(|(_, b)| b)
        .unwrap_or(text);
    Page {
        slug,
        title,
        description,
        body: body.trim_start(),
    }
}

pub fn pages() -> Vec<Page> {
    DOCS.iter().map(|(slug, text)| page(slug, text)).collect()
}

/// The topic list, or one page; with `section`, only the part under the
/// `##` heading that contains it (and its subsections).
pub fn read(topic: Option<&str>, section: Option<&str>) -> Result<serde_json::Value, String> {
    let all = pages();
    let Some(topic) = topic.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(serde_json::json!({
            "about": "Orca's documentation, as on orca-desktop.com/docs for this version. Read a page with topic set to its slug; add section to get one part of it.",
            "topics": all.iter().map(|p| serde_json::json!({ "topic": p.slug, "title": p.title, "about": p.description })).collect::<Vec<_>>(),
        }));
    };
    let topic = topic
        .trim_matches('/')
        .trim_start_matches("docs/")
        .trim_end_matches('/');
    let p = all
        .iter()
        .find(|p| p.slug == topic)
        .ok_or_else(|| format!("No docs page '{topic}'. Call orca_docs without a topic for the list."))?;
    let text = match section.map(str::trim).filter(|s| !s.is_empty()) {
        None => p.body.to_string(),
        Some(want) => section_of(p.body, want).ok_or_else(|| {
            let heads: Vec<&str> = p
                .body
                .lines()
                .filter(|l| l.starts_with("## "))
                .map(|l| &l[3..])
                .collect();
            format!(
                "'{}' has no section '{want}'. Its sections: {}",
                p.slug,
                heads.join(", ")
            )
        })?,
    };
    Ok(serde_json::json!({
        "topic": p.slug,
        "title": p.title,
        "url": format!("https://orca-desktop.com/docs/{}/", p.slug),
        "markdown": text,
    }))
}

/// The `##` section whose heading contains `want`, up to the next `##`.
fn section_of(body: &str, want: &str) -> Option<String> {
    let want = want.to_lowercase();
    let mut out = Vec::new();
    let mut inside = false;
    let mut fenced = false;
    for line in body.lines() {
        // A `## ` inside a code block is code, not a heading.
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        if let Some(h) = line.strip_prefix("## ").filter(|_| !fenced) {
            if inside {
                break;
            }
            inside = h.to_lowercase().contains(&want);
        }
        if inside {
            out.push(line);
        }
    }
    (!out.is_empty()).then(|| out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_docs_are_built_in() {
        let all = pages();
        let databases = all.iter().find(|p| p.slug == "databases").expect("the databases page");
        assert_eq!(databases.title, "Databases");
        assert!(databases.body.contains("requires:") && !databases.body.starts_with("---"));
        let yaml = all
            .iter()
            .find(|p| p.slug == "orca-yaml")
            .expect("the shared orca.yaml page");
        assert_eq!(yaml.title, "orca.yaml reference");
        assert!(!yaml.body.starts_with("# "));
    }

    #[test]
    fn reads_a_topic_list_a_page_or_a_section() {
        let list = read(None, None).unwrap();
        assert!(list["topics"].as_array().unwrap().len() > 20);
        let page = read(Some("/docs/databases/"), None).unwrap();
        assert!(page["markdown"].as_str().unwrap().contains("## How it works"));
        let part = read(Some("databases"), Some("shared servers")).unwrap();
        let md = part["markdown"].as_str().unwrap();
        assert!(
            md.starts_with("## Shared servers in a workspace") && !md.contains("## Servers Orca runs"),
            "{md}"
        );
        assert!(read(Some("nope"), None).unwrap_err().contains("without a topic"));
        assert!(
            read(Some("databases"), Some("zzz"))
                .unwrap_err()
                .contains("Its sections")
        );
    }
}
