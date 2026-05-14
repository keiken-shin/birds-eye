# Workspace UI & 3D Visualization Redesign

## 1. Scope
A complete structural overhaul of the frontend UI to transition from a stacked-card dashboard into a spatial, modular canvas mimicking a professional IDE layout, featuring a procedural 3D storage visualization engine.

## 2. Architecture & Views
### 2.1 Scan Landing Page (`<ScanLanding />`)
* **Role:** Dedicated initial viewport before dropping into the workspace.
* **Visuals:** Dotted sci-fi grid backdrop. Centers around an active scanning visualization.
* **Metrics:** Surfaces active hardware utilization (CPU/Mem), scan speed (files/sec), and current processing path.
* **Flow:** Auto-transitions to the Main Workspace immediately upon 100% completion.

### 2.2 Main Workspace Layout (IDE-Style)
* **Underlying Mechanism:** CSS Grid / Flex layout featuring fixed docking regions with draggable resize handles (combining Approach C structure with Approach B predefined zones).
* **Backdrop:** Global dotted grid canvas, matching the "edgeless open canvas" sci-fi aesthetic.
* **Regions:**
  * **Center (Main Canvas):** Dedicated entirely to the Storage Visualization (3D or 2D).
  * **Left Dock:** Contexts and Filters (Media kinds, Extensions). Collapsible.
  * **Right Dock (Inspector):** Bifurcated layout. Top half for selected entity metadata. Bottom half strictly for "Suggested Moves" and "Cleanup Alerts".
  * **Bottom Dock:** Timeline scatter plot and Staged Review Queue. Collapsible/Resizable.

## 3. Storage Visualization Engine (Treemap Canvas)
### 3.1 3D Mode (Default)
* **Implementation:** Three.js via `react-three-fiber` and `react-three-drei`, heavily inspired by `docs/storage-visualizer.html`.
* **Visual Metaphors:**
  * **Top-Level Folders:** Rendered as structural elements (Racks, Storage Zones).
  * **Files:** Represented as individual storage boxes/nodes within those racks.
  * **Aesthetics:** Neon glowing edges (`UnrealBloomPass`), grid floors, ambient point lights, and floating particles.
* **Interaction:** Raycasting controls hover states (lifting elements, showing detailed glass-pane tooltips). Camera respects orbit controls (Left-click rotate, Right-click pan, Scroll zoom).

### 3.2 2D Mode (Toggleable)
* **Role:** High-density, fast-glance mode.
* **Visuals:** Flat, explicitly color-coded rectangles. Drops faux-depth and shadows completely, optimizing for maximum readability rather than spatial immersion.

## 4. Navigation & Global Controls
* **Spotlight File Search:** Abstracted away from standard tabs. Implemented as an omnipresent command palette (e.g., accessed via Cmd/Ctrl + K or floating top-bar input). Selecting a result flies the visualization camera directly to the asset.
* **Settings & Shortcuts:**
  * Settings abstracted into a discrete icon button to minimize conflict.
  * Keyboard Shortcuts moved inside the Settings modal (or behind a minor `?` icon) to establish proper hierarchical attention.