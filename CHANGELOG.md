# Changelog

All notable changes to the "Python Inheritance Visualizer" extension will be documented in this file.

## [0.3.1] - 2026-04-14
### Added
- Interactive re-indexing prompts when visualization settings change.
- Full English localization for all UI messages and notifications.
### Changed
- Improved memory and CPU efficiency by skipping indexing of disabled member types (variables/methods).
- Synchronized CodeLens visibility with Gutter icons.

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
