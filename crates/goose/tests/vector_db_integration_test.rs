/// Integration tests for vector database functionality
///
/// These tests require a running Qdrant instance:
/// ```bash
/// docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant
/// ```

#[cfg(feature = "vector-db")]
mod vector_db_tests {
    use goose::vector_db::{DistanceMetric, EmbeddingGenerator, VectorDbClient, VectorDbConfig};

    #[tokio::test]
    #[ignore] // Requires: docker run -p 6334:6334 qdrant/qdrant
    async fn test_embedding_generation() {
        let generator = EmbeddingGenerator::new().expect("Failed to create generator");

        assert_eq!(generator.dimension(), 384);

        let embedding = generator
            .embed_single("Hello, world!")
            .expect("Failed to generate embedding");

        assert_eq!(embedding.len(), 384);
        assert!(embedding.iter().all(|&x| x.is_finite()));
    }

    #[tokio::test]
    #[ignore] // Requires: docker run -p 6334:6334 qdrant/qdrant
    async fn test_batch_embedding() {
        let generator = EmbeddingGenerator::new().expect("Failed to create generator");

        let texts = vec![
            "Rust is a systems programming language".to_string(),
            "Python is great for data science".to_string(),
            "JavaScript runs in browsers".to_string(),
        ];

        let embeddings = generator.embed(&texts).expect("Failed to generate embeddings");

        assert_eq!(embeddings.len(), 3);
        assert!(embeddings.iter().all(|emb| emb.len() == 384));
    }

    #[tokio::test]
    #[ignore] // Requires: docker run -p 6334:6334 qdrant/qdrant
    async fn test_vector_db_end_to_end() {
        let config = VectorDbConfig {
            collection_name: "test_e2e_collection".to_string(),
            ..Default::default()
        };

        let client = VectorDbClient::new(config)
            .await
            .expect("Failed to create client");

        client
            .init_collection()
            .await
            .expect("Failed to initialize collection");

        let generator = EmbeddingGenerator::new().expect("Failed to create generator");

        let docs = vec![
            "Rust is fast and memory-safe".to_string(),
            "Python is easy to learn".to_string(),
            "Go has great concurrency support".to_string(),
        ];

        let embeddings = generator.embed(&docs).expect("Failed to generate embeddings");

        client
            .insert_batch(vec![
                (
                    "doc1".to_string(),
                    docs[0].clone(),
                    embeddings[0].clone(),
                    Some(serde_json::json!({"lang": "rust"})),
                ),
                (
                    "doc2".to_string(),
                    docs[1].clone(),
                    embeddings[1].clone(),
                    Some(serde_json::json!({"lang": "python"})),
                ),
                (
                    "doc3".to_string(),
                    docs[2].clone(),
                    embeddings[2].clone(),
                    Some(serde_json::json!({"lang": "go"})),
                ),
            ])
            .await
            .expect("Failed to insert batch");

        let (point_count, vector_size) = client.stats().await.expect("Failed to get stats");
        assert_eq!(point_count, 3);
        assert_eq!(vector_size, 384);

        let query_embedding = generator
            .embed_single("fast programming language")
            .expect("Failed to generate query embedding");

        let results = client
            .search(query_embedding, 5)
            .await
            .expect("Failed to search");

        assert!(!results.is_empty());
        assert_eq!(results[0].text, "Rust is fast and memory-safe");
        assert!(results[0].metadata.is_some());

        client.delete("doc1").await.expect("Failed to delete");

        let (point_count_after, _) = client.stats().await.expect("Failed to get stats");
        assert_eq!(point_count_after, 2);
    }

    #[tokio::test]
    #[ignore] // Requires: docker run -p 6334:6334 qdrant/qdrant
    async fn test_different_distance_metrics() {
        for (metric, collection_name) in [
            (DistanceMetric::Cosine, "test_cosine"),
            (DistanceMetric::Euclidean, "test_euclidean"),
            (DistanceMetric::Dot, "test_dot"),
        ] {
            let config = VectorDbConfig {
                collection_name: collection_name.to_string(),
                distance: metric,
                ..Default::default()
            };

            let client = VectorDbClient::new(config)
                .await
                .expect("Failed to create client");

            client
                .init_collection()
                .await
                .expect("Failed to initialize collection");

            let generator = EmbeddingGenerator::new().expect("Failed to create generator");
            let embedding = generator
                .embed_single("test document")
                .expect("Failed to generate embedding");

            client
                .insert("test_id", "test document", embedding.clone(), None)
                .await
                .expect("Failed to insert");

            let results = client
                .search(embedding, 1)
                .await
                .expect("Failed to search");

            assert_eq!(results.len(), 1);
            assert_eq!(results[0].id, "test_id");
        }
    }

    #[tokio::test]
    #[ignore] // Requires: docker run -p 6334:6334 qdrant/qdrant
    async fn test_dimension_mismatch_error() {
        let config = VectorDbConfig {
            collection_name: "test_dimension_mismatch".to_string(),
            vector_size: 384,
            ..Default::default()
        };

        let client = VectorDbClient::new(config)
            .await
            .expect("Failed to create client");

        client
            .init_collection()
            .await
            .expect("Failed to initialize collection");

        let wrong_embedding = vec![0.1; 128];

        let result = client
            .insert("test_id", "test", wrong_embedding, None)
            .await;

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Embedding dimension mismatch"));
    }
}
