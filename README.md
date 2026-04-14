# Python Inheritance Visualizer 🐍✨

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Visualize Python class inheritance and method overrides right in your editor's gutter. A powerful PyCharm-like feature for VS Code and Cursor.

![Demo](./resources/demo.png)

## Main Features

- **Gutter Icons**: Instant visual cues (↑, ↓, ↕) in the gutter to see if a method is an override or has implementations in subclasses.
- **CodeLens Links**: Clickable links above methods/variables for quick navigation to parents or children.
- **Smart Hops**: Support for re-exports and deep resolution through `__init__.py` (Standard & Third-party libraries support).
- **Class Variables Support**: Visualize overrides for class fields and constants.
- **High Performance**: Custom graph-based indexing engine that works in the background and respects your CPU/RAM.
- **Configurable**: Choose what to visualize and when to index.

## Customization

The extension provides several options to balance performance and visibility:

- **Analyze External Libraries**: Enable/disable deep analysis of system and third-party packages.
- **Visualize Variables/Methods**: Separately toggle visibility for class fields and methods.
- **Indexing Strategy**: 
    - `onType`: Real-time updates as you type (with a smart 1.5s delay).
    - `onSave`: Update index only when you save a file.
    - `manual`: For maximum control, update only via command or on file open.
- **Index on Startup**: Background scan of the whole workspace on extension start.

## How it works
The extension builds a **high-performance inheritance graph** of your entire project. Unlike other tools, it doesn't overload the Language Server (Pylance) with per-method requests but calculates relations in-memory, ensuring a smooth experience even on large projects.

---

## Example

### `base.py`
```python
class BaseService:
    def process(self):  # [↓ overridden in 1 subclasses]
        print("Base processing")
```

### `service.py`
```python
from base import BaseService

class PaymentService(BaseService):
    def process(self):  # [↑ overrides BaseService.process]
        print("Payment processing")
        super().process()
```

In the editor, you will see clickable links and gutter icons:
- In `base.py`: `↓ overridden in 1 subclasses`
- In `service.py`: `↑ overrides BaseService.process (base.py)`

## Installation

1. Download the `.vsix` file from [Releases](https://github.com/KorotkoVladimir/vscode-inheritance/releases).
2. In VS Code, run: `Extensions: Install from VSIX...`.
3. Open any Python project and wait for the initial indexing (see notification/Output Channel).

## Requirements
- **Python** extension (ms-python.python)
- **Pylance** language server (Recommended)

## License
MIT. See [LICENSE](LICENSE) for details.

---
Built with love for Python developers. ❤️
