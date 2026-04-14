# Changelog

All notable changes to the "Python Inheritance Visualizer" extension will be documented in this file.

## [0.3.11] - 2026-04-14
### Optimized
- **Navigation UX**: CodeLens now performs an immediate jump if there is only one inheritance target.
- **Path Visualization**: Improved target paths in the selection menu. Project files show relative paths, while library files show clean paths relative to `site-packages` or standard library.

## [0.3.10] - 2026-04-14
- **Navigation Error**: Fixed 'pythonInheritance.showTargets not found' error by implementing the missing command and registering it in the manifest.
- **Improved Logging**: All commands now have automatic error capturing and logging to the Output Channel for better diagnostics.
### Added
- **Explicit Navigation Commands**: Added implementation for `goToSuper` and `goToSub` internal commands.

## [0.3.9] - 2026-04-14
- **Global Semantic Caching**: Implemented a project-wide session cache for dotted names (e.g., `json.JSONEncoder`). This eliminates thousands of redundant Pylance calls, drastically reducing background resolution time.

## [0.3.8] - 2026-04-14
- **Fast Project Lookups**: Implemented a global class name index (O(1)) for background resolution, reducing Phase 2 time from minutes to seconds.
- **Cleaner Logs**: Reduced logging frequency to once per 500 files to minimize Output Channel overhead.

## [0.3.7] - 2026-04-14
- **Discovery Pass Architecture**: Restored instant indexing speed by separating structural discovery from semantic resolution.
- **Lazy Resolution**: Internal project links are established instantly based on names, while external library links (like `json.JSONEncoder`) are resolved lazily in the background.
- **Semantic Caching**: Results of Pylance "Go to Definition" are now cached to avoid redundant network/IPC calls.
### Fixed
- Fixed all hangs during indexing by eliminating semantic dependencies in the primary indexing phase.

## [0.3.6] - 2026-04-14
- **Linear Indexing (No-Recursion Phase 1)**: Each project file is processed exactly once, eliminating deadlocks and massive redundant work for complex inheritance trees.
- **Improved Progress Feedback**: Added detailed Output Channel logs every 100 files to track real-time progress.
### Changed
- Recursion is now strictly reserved for Phase 2 (external libraries) and single-file updates.

## [0.3.5] - 2026-04-14
- **Two-Phase Indexing**: Architecture split into Project Indexing (Phase 1) and Library Indexing (Phase 2).
- **Intermediate Auto-Save**: Project data is saved to disk immediately after Phase 1, enabling navigation before libraries are fully processed.
- **Pylance Semaphore**: Global limit on concurrent Language Server requests to prevent hangs and "choking" on large projects.
### Fixed
- Fixed deadlocks caused by circular imports during parallel indexing.

## [0.3.4] - 2026-04-14
- **Performance Regression**: Fixed duplicate analysis of common base classes in parallel mode using a shared promise cache.
### Changed
- **Silenced Logs**: Moved mass analysis logs to `debug` level. Only significant milestones are now shown in `info`.
- Reduced UI update and storage save frequency during large indexing runs to further improve performance.

## [0.3.3] - 2026-04-14
- **Optimized Startup**: Fast parallel pre-scan (fs.stat) for workspace files, reducing startup delay by several seconds on large projects.
- **Improved Logging**: Detailed timing for every indexing stage (Scan, Pre-scan, Indexing).
### Changed
- Clarified `indexingConcurrency` setting description in the IDE (now "Parallel Indexing Threads").

## [0.3.2] - 2026-04-14
### Added
- **Parallel Indexing**: Significantly faster project scanning using a worker pool with configurable concurrency.
- **indexingConcurrency Setting**: New setting to control the number of parallel indexing tasks (Default: 6).
### Changed
- Refactored `analyzeFile` to use `Uri` and lazy document loading for better memory management during large scans.
- Improved progress reporting with percentage and file counts.

## [0.3.1] - 2026-04-14

## [0.3.0] - 2026-04-14
### Added
- New configuration settings for fine-grained visualization control (Toggle Class Variables/Methods).
- Multiple indexing strategies: `onSave`, `onType` (with 1.5s debounce), and `manual`.
- Option to enable/disable workspace scanning on startup (`indexOnStartup`).
- Setting to toggle analysis of external (standard/third-party) libraries.
### Changed
- Instant UI update when configuration changes without window reload.

## [0.2.9] - 2026-04-14
### Added
- Enhanced diagnostic logging for "Smart Hops".
- Improved resolution accuracy for dotted class names (e.g., `json.JSONEncoder`).

## [0.2.8] - 2026-04-14
### Added
- "Smart Hops" technology to follow re-exports through `__init__.py` files.
- Built-in types filtering to prevent circular dependencies and noise in the inheritance graph.

## [0.2.7] - 2026-04-14
### Added
- Detailed logging for inheritance resolution to the Output Channel.

## [0.2.6] - 2026-04-14
### Added
- "Python Inheritance: Reindex Project" command to manually rebuild the inheritance graph.

## [0.2.5] - 2026-04-14
### Added
- Dedicated Output Channel for diagnostic logs.
### Fixed
- Decoration update issues (flickering and stale icons).

## [0.1.5] - 2026-04-10
### Added
- Initial implementation of the high-performance graph-based indexing.
- Gutter icons for overrides and implementations.
- CodeLens links to jump between base classes and subclasses.
