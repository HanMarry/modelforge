//! Masking rule for API keys and auth header values in logs, errors and exports
//! (requirement 1.10). The desktop applies the same rule in
//! `ui/desktop/src/utils/secretMask.ts`; both are checked against
//! `fixtures/secret-mask-vectors.json`.
//!
//! The output never reveals the length: always eight asterisks, followed by the last four
//! characters (Unicode scalar values) when the value is longer than eight.

pub const MASK_PREFIX: &str = "********";

/// Values this short would match ordinary text, so they are not searched for.
const MIN_REDACT_CHARS: usize = 5;

pub fn mask_secret(value: &str) -> String {
    let count = value.chars().count();
    if count <= 8 {
        return MASK_PREFIX.to_string();
    }
    let tail: String = value.chars().skip(count - 4).collect();
    format!("{MASK_PREFIX}{tail}")
}

/// Replaces every known secret in `text` with its mask. Longer secrets go first so a secret
/// that contains another is replaced whole; ties are ordered by code point (byte order of UTF-8)
/// so the desktop implementation produces the same output when two secrets overlap.
pub fn redact_text<'a, I>(text: &str, secrets: I) -> String
where
    I: IntoIterator<Item = &'a str>,
{
    let mut candidates: Vec<&str> = secrets
        .into_iter()
        .filter(|secret| secret.chars().count() >= MIN_REDACT_CHARS)
        .collect();
    candidates.sort_by(|a, b| {
        b.chars()
            .count()
            .cmp(&a.chars().count())
            .then_with(|| a.cmp(b))
    });
    candidates.dedup();

    let mut result = text.to_string();
    for secret in candidates {
        if result.contains(secret) {
            result = result.replace(secret, &mask_secret(secret));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct MaskVector {
        input: String,
        masked: String,
    }

    #[derive(Deserialize)]
    struct RedactVector {
        text: String,
        secrets: Vec<String>,
        expected: String,
    }

    #[derive(Deserialize)]
    struct Vectors {
        mask: Vec<MaskVector>,
        redact: Vec<RedactVector>,
    }

    fn vectors() -> Vectors {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/secret-mask-vectors.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("reading {}: {error}", path.display()));
        serde_json::from_str(&raw).expect("secret-mask-vectors.json is valid")
    }

    #[test]
    fn matches_the_shared_vectors() {
        let vectors = vectors();
        for vector in &vectors.mask {
            assert_eq!(
                mask_secret(&vector.input),
                vector.masked,
                "{:?}",
                vector.input
            );
        }
        for vector in &vectors.redact {
            let redacted = redact_text(&vector.text, vector.secrets.iter().map(String::as_str));
            assert_eq!(redacted, vector.expected, "{:?}", vector.text);
        }
    }

    /// Secrets never consist of mask characters, otherwise a mask could equal its own input.
    fn secret_strategy() -> impl Strategy<Value = String> {
        proptest::collection::vec(
            prop::sample::select(vec![
                'a', 'b', 'c', 'X', 'Y', 'Z', '0', '1', '9', '-', '_', '中', '文', '键', '🔑', 'é',
            ]),
            0..20,
        )
        .prop_map(|chars| chars.into_iter().collect())
    }

    // Feature: mathmodel-parity-and-beyond, Property 7: 敏感值掩码
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]

        #[test]
        fn mask_keeps_at_most_the_last_four_chars(value in ".{0,40}") {
            let chars: Vec<char> = value.chars().collect();
            let masked = mask_secret(&value);
            if chars.len() <= 8 {
                prop_assert_eq!(masked, MASK_PREFIX);
            } else {
                let tail: String = chars[chars.len() - 4..].iter().collect();
                prop_assert_eq!(masked, format!("{MASK_PREFIX}{tail}"));
            }
        }

        #[test]
        fn redaction_leaves_no_secret_longer_than_four_chars(
            (secrets, text) in (
                proptest::collection::vec(secret_strategy(), 0..6),
                proptest::collection::vec(".{0,6}", 0..8),
            )
                .prop_flat_map(|(secrets, filler)| {
                    let parts: Vec<String> =
                        secrets.iter().chain(filler.iter()).chain(secrets.iter()).cloned().collect();
                    (Just(secrets), Just(parts).prop_shuffle())
                })
                .prop_map(|(secrets, parts)| (secrets, parts.concat()))
        ) {
            let redacted = redact_text(&text, secrets.iter().map(String::as_str));
            for secret in &secrets {
                if secret.chars().count() > 4 {
                    prop_assert!(!redacted.contains(secret.as_str()), "{secret:?} left in {redacted:?}");
                }
            }
        }
    }
}
