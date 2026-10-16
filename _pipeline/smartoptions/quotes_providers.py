"""Local adapter to the same standalone provider implementation shipped to Pages.

The scripts module has no project dependencies; keeping one implementation avoids
divergence between GitHub Actions and the foreground local refresh loop.
"""
from scripts.gh_quotes_refresh import refresh, main

__all__ = ["refresh", "main"]
