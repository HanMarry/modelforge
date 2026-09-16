/// Qdrant vector database client
///
/// Provides high-level interface for storing and searching vectors.

use anyhow::{Context, Result};
use qdrant_client::prelude::*;
use qdrant_client::qdrant::{
    vectors_config::Config, CreateCollection, Distance, SearchPoints, VectorParams, VectorsConfig,
};
use serde::{Deserialize, Serialize};

use super::{DistanceMetric, VectorDbConfig};

/// Client for interacting with Qdrant vector database
pub struct VectorDbClient {
    client: QdrantClient,
    config: VectorDbConfig,
}

/// Search result from vector database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    /// Document ID
    pub id: String,
    /// Similarity score (interpretation depends on distance metric)
    pub score: f32,
    /// Original text content
    pub text: String,
    /// Optional metadata
    pub metadata: Option<serde_json::Value>,
}

impl VectorDbClient {
    /// Create a new Qdrant client
    ///
    /// # Arguments
    /// - `config` - Vector database configuration
    ///
    /// # Returns
    /// - `Ok(VectorDbClient)` if connection succeeds
    /// - `Err` if connection or initialization fails
    pub async fn new(config: VectorDbConfig) -> Result<Self> {
        let client = QdrantClient::from_url(&config.url)
            .build()
            .context("Failed to create Qdrant client")?;

        Ok(Self { client, config })
    }

    /// Initialize the collection (create if doesn't exist)
    ///
    /// # Returns
    /// - `Ok(())` if collection exists or was created successfully
    /// - `Err` if creation fails
    pub async fn init_collection(&self) -> Result<()> {
        // Check if collection exists
        let collections = self
            .client
            .list_collections()
            .await
            .context("Failed to list collections")?;

        let collection_exists = collections
            .collections
            .iter()
            .any(|c| c.name == self.config.collection_name);

        if collection_exists {
            return Ok(());
        }

        // Create collection with configured vector size and distance metric
        let distance = match self.config.distance {
            DistanceMetric::Cosine => Distance::Cosine,
            DistanceMetric::Euclidean => Distance::Euclid,
            DistanceMetric::Dot => Distance::Dot,
        };

        self.client
            .create_collection(&CreateCollection {
                collection_name: self.config.collection_name.clone(),
                vectors_config: Some(VectorsConfig {
                    config: Some(Config::Params(VectorParams {
                        size: self.config.vector_size as u64,
                        distance: distance.into(),
                        ..Default::default()
                    })),
                }),
                ..Default::default()
            })
            .await
            .context("Failed to create collection")?;

        Ok(())
    }

    /// Insert a single document with its embedding
    ///
    /// # Arguments
    /// - `id` - Unique document ID
    /// - `text` - Document text content
    /// - `embedding` - Pre-computed embedding vector
    /// - `metadata` - Optional metadata to store with document
    ///
    /// # Returns
    /// - `Ok(())` if insertion succeeds
    /// - `Err` if insertion fails
    pub async fn insert(
        &self,
        id: &str,
        text: &str,
        embedding: Vec<f32>,
        metadata: Option<serde_json::Value>,
    ) -> Result<()> {
        if embedding.len() != self.config.vector_size {
            anyhow::bail!(
                "Embedding dimension mismatch: expected {}, got {}",
                self.config.vector_size,
                embedding.len()
            );
        }

        let mut payload = serde_json::json!({
            "text": text,
        });

        if let Some(meta) = metadata {
            payload["metadata"] = meta;
        }

        let point = PointStruct::new(id.to_string(), embedding, payload);

        self.client
            .upsert_points_blocking(&self.config.collection_name, None, vec![point], None)
            .await
            .context("Failed to insert point")?;

        Ok(())
    }

    /// Insert multiple documents in batch
    ///
    /// # Arguments
    /// - `documents` - Vec of (id, text, embedding, metadata) tuples
    ///
    /// # Returns
    /// - `Ok(())` if all insertions succeed
    /// - `Err` if any insertion fails
    pub async fn insert_batch(
        &self,
        documents: Vec<(String, String, Vec<f32>, Option<serde_json::Value>)>,
    ) -> Result<()> {
        let points: Vec<PointStruct> = documents
            .into_iter()
            .map(|(id, text, embedding, metadata)| {
                if embedding.len() != self.config.vector_size {
                    anyhow::bail!(
                        "Embedding dimension mismatch for {}: expected {}, got {}",
                        id,
                        self.config.vector_size,
                        embedding.len()
                    );
                }

                let mut payload = serde_json::json!({
                    "text": text,
                });

                if let Some(meta) = metadata {
                    payload["metadata"] = meta;
                }

                Ok(PointStruct::new(id, embedding, payload))
            })
            .collect::<Result<Vec<_>>>()?;

        self.client
            .upsert_points_blocking(&self.config.collection_name, None, points, None)
            .await
            .context("Failed to insert batch")?;

        Ok(())
    }

    /// Search for similar documents using a query embedding
    ///
    /// # Arguments
    /// - `query_embedding` - Query vector
    /// - `limit` - Maximum number of results to return
    ///
    /// # Returns
    /// - `Ok(Vec<SearchResult>)` - Ranked search results
    /// - `Err` if search fails
    pub async fn search(
        &self,
        query_embedding: Vec<f32>,
        limit: usize,
    ) -> Result<Vec<SearchResult>> {
        if query_embedding.len() != self.config.vector_size {
            anyhow::bail!(
                "Query embedding dimension mismatch: expected {}, got {}",
                self.config.vector_size,
                query_embedding.len()
            );
        }

        let search_result = self
            .client
            .search_points(&SearchPoints {
                collection_name: self.config.collection_name.clone(),
                vector: query_embedding,
                limit: limit as u64,
                with_payload: Some(true.into()),
                ..Default::default()
            })
            .await
            .context("Failed to search points")?;

        let results = search_result
            .result
            .into_iter()
            .filter_map(|point| {
                let payload = point.payload;
                let text = payload.get("text")?.as_str()?.to_string();
                let metadata = payload.get("metadata").cloned();

                Some(SearchResult {
                    id: point.id?.to_string(),
                    score: point.score,
                    text,
                    metadata,
                })
            })
            .collect();

        Ok(results)
    }

    /// Delete a document by ID
    ///
    /// # Arguments
    /// - `id` - Document ID to delete
    ///
    /// # Returns
    /// - `Ok(())` if deletion succeeds
    /// - `Err` if deletion fails
    pub async fn delete(&self, id: &str) -> Result<()> {
        self.client
            .delete_points(
                &self.config.collection_name,
                None,
                &[id.into()],
                None,
            )
            .await
            .context("Failed to delete point")?;

        Ok(())
    }

    /// Get collection statistics
    ///
    /// # Returns
    /// - `Ok((point_count, vector_size))` - Number of points and configured vector dimension
    /// - `Err` if retrieval fails
    pub async fn stats(&self) -> Result<(usize, usize)> {
        let info = self
            .client
            .collection_info(&self.config.collection_name)
            .await
            .context("Failed to get collection info")?;

        let point_count = info
            .result
            .and_then(|r| r.points_count)
            .unwrap_or(0) as usize;

        Ok((point_count, self.config.vector_size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Requires running Qdrant instance
    async fn test_vector_db_lifecycle() {
        let config = VectorDbConfig {
            collection_name: "test_collection".to_string(),
            ..Default::default()
        };

        let client = VectorDbClient::new(config)
            .await
            .expect("Failed to create client");

        // Initialize collection
        client
            .init_collection()
            .await
            .expect("Failed to init collection");

        // Insert test document
        let embedding = vec![0.1; 384];
        client
            .insert("test_id", "Test document", embedding.clone(), None)
            .await
            .expect("Failed to insert");

        // Search
        let results = client
            .search(embedding, 5)
            .await
            .expect("Failed to search");

        assert!(!results.is_empty());
        assert_eq!(results[0].text, "Test document");

        // Delete
        client.delete("test_id").await.expect("Failed to delete");
    }
}
