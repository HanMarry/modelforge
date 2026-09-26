/// Qdrant vector database client
///
/// Provides high-level interface for storing and searching vectors.
use anyhow::{Context, Result};
use qdrant_client::qdrant::{
    point_id::PointIdOptions, CreateCollectionBuilder, DeletePointsBuilder, Distance, PointId,
    PointStruct, SearchPointsBuilder, UpsertPointsBuilder, VectorParamsBuilder,
};
use qdrant_client::{Payload, Qdrant};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{DistanceMetric, VectorDbConfig};

/// UUID namespace for deriving deterministic point IDs from user-supplied strings.
const ID_NAMESPACE: Uuid = Uuid::from_bytes([
    0x6b, 0xa7, 0xb8, 0x20, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]);

/// Convert a user-supplied string ID to a Qdrant-compatible point ID.
///
/// Qdrant only accepts u64 or UUID point IDs. We derive a deterministic UUID v5
/// from the user string so that arbitrary string IDs work end-to-end.
fn str_to_point_id(id: &str) -> PointId {
    PointId::from(Uuid::new_v5(&ID_NAMESPACE, id.as_bytes()).to_string())
}

/// Client for interacting with Qdrant vector database
pub struct VectorDbClient {
    client: Qdrant,
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
        let client = Qdrant::from_url(&config.url)
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
            .create_collection(
                CreateCollectionBuilder::new(self.config.collection_name.clone()).vectors_config(
                    VectorParamsBuilder::new(self.config.vector_size as u64, distance),
                ),
            )
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

        let payload = build_payload(id, text, metadata)?;
        let point = PointStruct::new(str_to_point_id(id), embedding, payload);

        self.client
            .upsert_points(
                UpsertPointsBuilder::new(self.config.collection_name.clone(), vec![point])
                    .wait(true),
            )
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

                let payload = build_payload(&id, &text, metadata)?;
                Ok(PointStruct::new(str_to_point_id(&id), embedding, payload))
            })
            .collect::<Result<Vec<_>>>()?;

        self.client
            .upsert_points(
                UpsertPointsBuilder::new(self.config.collection_name.clone(), points).wait(true),
            )
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
            .search_points(
                SearchPointsBuilder::new(
                    self.config.collection_name.clone(),
                    query_embedding,
                    limit as u64,
                )
                .with_payload(true),
            )
            .await
            .context("Failed to search points")?;

        let results = search_result
            .result
            .into_iter()
            .filter_map(|point| {
                let id = point.payload.get("id")?.as_str()?.to_string();
                let text = point.payload.get("text")?.as_str()?.to_string();
                let metadata = point.payload.get("metadata").cloned().map(Into::into);

                Some(SearchResult {
                    id,
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
                DeletePointsBuilder::new(self.config.collection_name.clone())
                    .points(vec![str_to_point_id(id)])
                    .wait(true),
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
            .collection_info(self.config.collection_name.clone())
            .await
            .context("Failed to get collection info")?;

        let point_count = info.result.and_then(|r| r.points_count).unwrap_or(0) as usize;

        Ok((point_count, self.config.vector_size))
    }
}

fn build_payload(id: &str, text: &str, metadata: Option<serde_json::Value>) -> Result<Payload> {
    let mut payload = serde_json::json!({ "id": id, "text": text });
    if let Some(meta) = metadata {
        payload["metadata"] = meta;
    }
    Payload::try_from(payload).context("Failed to convert payload")
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
        let results = client.search(embedding, 5).await.expect("Failed to search");

        assert!(!results.is_empty());
        assert_eq!(results[0].text, "Test document");

        // Delete
        client.delete("test_id").await.expect("Failed to delete");
    }
}
