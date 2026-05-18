"""WSGI entry point.

For local development and the bundled Docker image, run ``serve.py`` which
enables mutual TLS. This module exposes the bare app for WSGI servers that
terminate TLS themselves (e.g. ``gunicorn wsgi:app`` behind a proxy).
"""
from app import create_app

app = create_app()
