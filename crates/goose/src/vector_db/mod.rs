/// Vector database integration module
///
/// Provides abstractions for vector storage and semantic search using Qdrant.
/// Embeddings are generated locally using FastEmbed.

#[cfg(feature = "vector-db")]
pub mod client;

#[cfg(feature = "vector-db")]
pub mod embeddings;

#[cfg(feature = "vector-db")]
pub use client::VectorDbClient;

#[cfg(feature = "vector-db")]
pub use embeddings::EmbeddingGenerator;

/// Vector database configuration
#[derive(Debug, Clone)]
pub struct VectorDbConfig {
    /// Qdrant server URL (e.g., "http://localhost:6334")
    pub url: String,
    /// Collection name for storing vectors
    pub collection_name: String,
    /// Vector dimension (must match embedding model)
    pub vector_size: usize,
    /// Distance metric for similarity search
    pub distance: DistanceMetric,
}

/// Distance metric for vector similarity
#[derive(Debug, Clone, Copy)]
pub enum DistanceMetric {
    /// Cosine similarity (range: -1 to 1, higher is more similar)
    Cosine,
    /// Euclidean distance (L2 norm, lower is more similar)
    Euclidean,
    /// Dot product (higher is more similar)
    Dot,
}

impl Default for VectorDbConfig {
    fn default() -> Self {
        Self {
            url: "http://localhost:6334".to_string(),
            collection_name: "goose_vectors".to_string(),
            vector_size: 384, // Default for all-MiniLM-L6-v2
            distance: DistanceMetric::Cosine,
        }
    }
}
