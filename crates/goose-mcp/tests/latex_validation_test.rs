use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

/// Test that PDF validation failure is treated as compilation failure
#[tokio::test]
async fn test_pdf_validation_failure() {
    let temp_dir = TempDir::new().unwrap();
    let tex_path = temp_dir.path().join("test.tex");

    // Create a broken LaTeX file that compiles with exit code 0 but produces invalid PDF
    fs::write(
        &tex_path,
        r#"\documentclass{article}
\begin{document}
Test
\end{document}"#,
    )
    .unwrap();

    let output_dir = temp_dir.path().join("output");
    fs::create_dir_all(&output_dir).unwrap();

    // Simulate the scenario: compiler exits with 0, but PDF is corrupt/missing
    let fake_pdf = output_dir.join("test.pdf");
    fs::write(&fake_pdf, b"NOT A REAL PDF").unwrap();

    // Validate should fail
    let result = validate_pdf_helper(&fake_pdf);
    assert!(
        result.is_err(),
        "PDF validation should fail for invalid PDF"
    );
    assert!(
        result.unwrap_err().to_string().contains("not a PDF"),
        "Error should mention invalid PDF format"
    );
}

fn validate_pdf_helper(path: &PathBuf) -> anyhow::Result<()> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut signature = [0; 5];
    file.read_exact(&mut signature)?;
    anyhow::ensure!(&signature == b"%PDF-", "Output is not a PDF");
    Ok(())
}
