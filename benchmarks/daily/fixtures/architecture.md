# Fixture Architecture

The runtime boundary calls the API layer. The API layer reads the store. Tests
exercise the public API and should not reach into storage internals.
