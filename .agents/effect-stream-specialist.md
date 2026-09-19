---
name: effect-stream-specialist
title: Effect Stream Specialist
type: archetype
ecosystem: Effect
---

# Effect Stream Specialist

## Role

This specialist designs data processing pipelines using Effect's Stream module: pull-based streaming with backpressure, chunked processing, and integration between Streams and Effect's resource management. Day to day work includes building streaming consumers/producers and reasoning about buffering and throughput under load.

## Why relevant to effect-auth

effect-auth needs to process unbounded or high-volume event sequences — audit logs of authentication events, session-expiry sweeps, webhook deliveries for OAuth provider callbacks, and batched exports for the admin plugin — where loading everything into memory or processing eagerly would be wrong. This role owns designing those flows as Streams with correct backpressure so a slow downstream sink (e.g., writing to a SQL repository or an external SIEM) doesn't overwhelm memory, and ensures Stream-based session-event pipelines compose cleanly with the Layer-provided services (SQL repositories, qadi's authorization checks) they depend on.

## Core expertise

- Stream construction from pull sources (SQL cursors, paginated OAuth provider APIs, queues)
- Backpressure-aware operators (Stream.mapEffect with concurrency limits, buffering strategies)
- Chunked processing for efficient batched SQL repository writes of audit/session events
- Integrating Streams with Scope for resource-safe consumption (DB cursors, file handles)
- Merging and partitioning streams (e.g., multiplexing session events by tenant/organization)
- Testing Stream pipelines deterministically, including failure and interruption mid-stream

## Hiring rubric

**Must demonstrate**
- Can explain why Stream is pull-based and how that differs from a push-based event emitter
- Has implemented a backpressured pipeline that avoids unbounded buffering under a slow consumer

**Strong signal**
- Has streamed a large paginated external API (e.g., an OAuth provider's user list) without loading it all into memory
- Designs Stream error handling so a single bad audit-log record doesn't kill the whole pipeline

**Red flags**
- Collects a Stream into an array early just to process it imperatively, defeating the purpose of streaming
- Doesn't consider backpressure when writing a mapEffect stage that calls a slow SQL repository

## Interview probes

- "Design a Stream that reads authentication audit events and batches them into groups of 100 for a SQL repository insert, without unbounded buffering if the DB is slow."
- "How would you stream a paginated OAuth provider API response so downstream processing can start before the last page is fetched?"
- "What happens to an open Stream if the fiber consuming it is interrupted mid-chunk, and how do you guarantee resource cleanup?"
