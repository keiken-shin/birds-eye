# Build a Native Disk Space Intelligence Platform

Create a production-grade desktop application for visualizing, analyzing, and organizing disk usage across large storage devices (external HDDs, SSDs, NAS folders, media archives).

The application should feel like a modern fusion of:

* WinDirStat
* WizTree
* Everything Search
* Plex-style media intelligence
* Modern analytics dashboards

Tech stack:

* Frontend: React + Vite + TypeScript + TailwindCSS + Framer Motion
* Backend: Rust (preferred via Tauri) OR Node.js + Electron
* Database: SQLite
* Visualization: D3.js or Apache ECharts
* Background Processing: Worker threads / async filesystem crawlers
* Optional: WASM acceleration for hashing

The app must support:

* Multi-million file indexing
* Fast incremental rescans
* Real-time progress updates
* Native filesystem access
* Background indexing
* Extremely low memory usage
* Responsive UI during scans

---

# Core Product Vision

The app should not merely scan folders.

It should act like a:
"Storage Intelligence System"

Users should immediately understand:

* where space is consumed
* what media dominates storage
* what can be cleaned
* where duplicates exist
* which folders are abandoned
* how storage evolved over time

The experience should feel premium, fluid, and analytical.

---

# Backend Architecture Requirements

Design a high-performance filesystem indexing engine.

## Scanner Engine

Requirements:

* Recursive filesystem traversal
* Parallel directory crawling
* Worker pool architecture
* Stream-based scanning
* Incremental indexing
* Cancellation support
* Pause/resume scanning
* Ignore inaccessible directories gracefully
* Detect symbolic links safely
* Prevent recursive symlink loops

Support:

* Windows
* macOS
* Linux

Backend should expose:

* Scan status
* ETA
* Current path
* Files scanned/sec
* Bytes scanned/sec
* Queue depth
* Worker utilization

Use event-driven architecture.

---

# Database Layer

Use SQLite.

Schema should support:

* files table
* folders table
* scan_sessions
* duplicate_groups
* media_metadata
* extension_stats
* timeline_history

Indexes must be optimized for:

* largest files queries
* folder aggregation
* duplicate detection
* extension filtering
* fast sorting

Support incremental rescans:

* modified timestamp checks
* deleted file cleanup
* hash invalidation

---

# Duplicate Detection System

Implement multi-stage duplicate detection.

Stage 1:

* size grouping

Stage 2:

* partial hashing

Stage 3:

* full hashing

Support:

* SHA256
* xxHash
* MD5

Display:

* duplicate groups
* reclaimable space
* confidence score

Add safe delete workflows:

* move to recycle bin
* preview before deletion
* protected folders list

---

# Media Intelligence

Detect and classify:

* photos
* videos
* music
* archives
* documents
* code
* installers
* AI models
* torrents
* disk images

Use:

* extension
* MIME type
* optional metadata extraction

Extract metadata:

* image resolution
* video duration
* codec
* bitrate
* camera metadata
* music tags

Optional:

* ffmpeg integration
* exiftool integration

---

# Visualization System

Implement a professional treemap engine.

Requirements:

* squarified treemap algorithm
* smooth zoom transitions
* folder drill-down
* animated resizing
* hover tooltips
* click navigation
* breadcrumb navigation

Alternative visualizations:

* sunburst chart
* storage timeline
* extension heatmap
* largest files graph
* duplicate cluster graph

Treemap performance target:

* 50,000+ nodes without lag

Use:

* Canvas rendering OR WebGL for large datasets

Avoid DOM-heavy rendering.

---

# Real-Time Scanning UX

During scan:

* live folder discovery
* animated progress bars
* rolling largest files
* rolling largest folders
* real-time charts
* category growth counters

Must never freeze UI.

Use:

* web workers
* background threads
* event streaming

---

# Search System

Implement instant search similar to Everything Search.

Requirements:

* fuzzy search
* extension filters
* regex support
* size filters
* date filters
* media-type filters

Search must remain fast across millions of files.

---

# Performance Goals

Target:

* 1M+ files indexed
* responsive under heavy load
* memory efficient
* incremental rescans under seconds

Optimize for:

* minimal object allocation
* streaming aggregation
* efficient string storage
* lazy loading
* virtualized rendering

---

# UI/UX Design Direction

Design language:

* dark modern analytics dashboard
* glassmorphism accents
* minimal but information-dense
* cyberpunk/media intelligence feel

Use:

* smooth animations
* gradient accents
* intelligent empty states
* contextual recommendations

Key screens:

1. Dashboard
2. Scan Manager
3. Treemap Explorer
4. Duplicate Finder
5. Largest Files
6. Media Library
7. Cleanup Recommendations
8. Timeline Analytics
9. Settings

---

# Cleanup Intelligence

Generate recommendations like:

* "48GB duplicate videos found"
* "Old installer cache consuming 22GB"
* "Unused archives not accessed in 3 years"
* "Large temporary folders detected"

Add:

* one-click cleanup
* smart rules
* cleanup simulation mode

---

# Advanced Features

Optional premium capabilities:

* AI image similarity detection
* semantic clustering
* face grouping
* screenshot detection
* blurry image detection
* torrent payload detection
* anime/movie/series grouping
* media deduplication by perceptual hash

---

# Engineering Constraints

The application must:

* operate fully offline
* never upload user files
* prioritize privacy
* handle scan interruptions safely
* recover corrupted indexes
* support huge external drives

Architecture must be modular and production-scalable.

---

# Deliverables

Generate:

1. Full architecture plan
2. Backend module structure
3. Database schema
4. API/event contract
5. Frontend component hierarchy
6. Worker-thread design
7. Treemap rendering strategy
8. Scan engine pseudocode
9. State management strategy
10. Incremental indexing strategy
11. Performance optimization plan
12. Security considerations
13. Packaging/distribution strategy

Then begin implementation in phases:
Phase 1 → Scanner core
Phase 2 → Database/indexing
Phase 3 → UI shell
Phase 4 → Treemap visualization
Phase 5 → Duplicate engine
Phase 6 → Media intelligence
Phase 7 → Optimization/polish
