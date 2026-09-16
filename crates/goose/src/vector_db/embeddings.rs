/// Embedding generation using FastEmbed
///
/// Generates vector embeddings for text using locally-run models.
use anyhow::{Context, Result};
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};

/// Generates embeddings for text using FastEmbed
pub struct EmbeddingGenerator {
    model: TextEmbedding,
    dimension: usize,
}

impl EmbeddingGenerator {
    /// Create a new embedding generator with the default model (all-MiniLM-L6-v2)
    ///
    /// # Returns
    /// - `Ok(EmbeddingGenerator)` if model loads successfully
    /// - `Err` if model download or initialization fails
    pub fn new() -> Result<Self> {
        Self::with_model(EmbeddingModel::AllMiniLML6V2)
    }

    /// Create an embedding generator with a specific model
    ///
    /// # Arguments
    /// - `model` - The FastEmbed model to use
    ///
    /// # Returns
    /// - `Ok(EmbeddingGenerator)` if model loads successfully
    /// - `Err` if model download or initialization fails
    pub fn with_model(model: EmbeddingModel) -> Result<Self> {
        let dimension = Self::model_dimension(&model);

        let text_embedding =
            TextEmbedding::try_new(TextInitOptions::new(model).with_show_download_progress(true))
                .context("Failed to initialize FastEmbed model")?;

        Ok(Self {
            model: text_embedding,
            dimension,
        })
    }

    /// Generate embeddings for a batch of text documents
    ///
    /// # Arguments
    /// - `texts` - Slice of text strings to embed
    ///
    /// # Returns
    /// - `Ok(Vec<Vec<f32>>)` - One embedding vector per input text
    /// - `Err` if embedding generation fails
    pub fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let embeddings = self
            .model
            .embed(texts.to_vec(), None)
            .context("Failed to generate embeddings")?;

        Ok(embeddings)
    }

    /// Generate embedding for a single text document
    ///
    /// # Arguments
    /// - `text` - Text string to embed
    ///
    /// # Returns
    /// - `Ok(Vec<f32>)` - Embedding vector
    /// - `Err` if embedding generation fails
    pub fn embed_single(&mut self, text: &str) -> Result<Vec<f32>> {
        let mut embeddings = self.embed(&[text.to_string()])?;
        embeddings
            .pop()
            .context("No embedding generated for input text")
    }

    /// Get the dimension of embeddings produced by this generator
    pub fn dimension(&self) -> usize {
        self.dimension
    }

    /// Get the embedding dimension for a specific model
    fn model_dimension(model: &EmbeddingModel) -> usize {
        match model {
            EmbeddingModel::AllMiniLML6V2 => 384,
            EmbeddingModel::BGEBaseENV15 => 768,
            EmbeddingModel::BGELargeENV15 => 1024,
            EmbeddingModel::BGESmallENV15 => 384,
            _ => 384, // Default fallback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_embedding_dimension() {
        assert_eq!(
            EmbeddingGenerator::model_dimension(&EmbeddingModel::AllMiniLML6V2),
            384
        );
        assert_eq!(
            EmbeddingGenerator::model_dimension(&EmbeddingModel::BGEBaseENV15),
            768
        );
    }

    #[test]
    #[ignore] // Requires model download
    fn test_embed_single() {
        let mut generator = EmbeddingGenerator::new().expect("Failed to create generator");
        let embedding = generator
            .embed_single("Hello, world!")
            .expect("Failed to generate embedding");

        assert_eq!(embedding.len(), 384);
        assert!(embedding.iter().all(|&x| x.is_finite()));
    }

    #[test]
    #[ignore] // Requires model download
    fn test_embed_batch() {
        let mut generator = EmbeddingGenerator::new().expect("Failed to create generator");
        let texts = vec!["First text".to_string(), "Second text".to_string()];
        let embeddings = generator
            .embed(&texts)
            .expect("Failed to generate embeddings");

        assert_eq!(embeddings.len(), 2);
        assert!(embeddings.iter().all(|emb| emb.len() == 384));
    }
}
