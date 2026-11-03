//! PdfCraft's Accessibility Checker, the full check, as one WebAssembly export for Caster's acceptance suite.
//!
//! `check(bytes)` opens the file and returns the report as JSON: one entry per rule with its id, category, name, status and findings. The types carry no serde, so the JSON is written by hand here.

use std::sync::Arc;

use pdfcraft_a11y::{Options, Report, Status, check as run};
use pdfcraft_cos::Document;
use wasm_bindgen::prelude::*;

/// The full check (31 of 32 rules, colour contrast off as in Acrobat) over `bytes`, as JSON; a file that will not open is a thrown string.
#[wasm_bindgen]
pub fn check(bytes: &[u8]) -> Result<String, JsError> {
    let doc = Document::open(Arc::new(bytes.to_vec())).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(to_json(&run(&doc, &Options::default())))
}

fn to_json(report: &Report) -> String {
    let mut out = String::from("[");
    for (i, r) in report.results.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"id\":{},\"category\":{},\"name\":{},\"status\":{},\"findings\":[",
            quote(r.rule.id()),
            quote(r.rule.category().label()),
            quote(r.rule.name()),
            quote(status(r.status))
        ));
        for (j, f) in r.findings.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"page\":{},\"object\":{},\"bbox\":{},\"message\":{}}}",
                f.page.map_or("null".to_owned(), |p| p.to_string()),
                f.object.map_or("null".to_owned(), |o| quote(&o.to_string())),
                f.bbox.map_or("null".to_owned(), |b| format!("[{},{},{},{}]", b[0], b[1], b[2], b[3])),
                quote(&f.message)
            ));
        }
        out.push_str("]}");
    }
    out.push(']');
    out
}

fn status(s: Status) -> &'static str {
    match s {
        Status::Passed => "pass",
        Status::Failed => "fail",
        Status::Manual => "manual",
        Status::Skipped => "skipped",
    }
}

fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

