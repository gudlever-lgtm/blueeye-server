"""Structured JSON error handling. Every error response is {"error": "..."}."""
import logging

from flask import jsonify
from werkzeug.exceptions import HTTPException

log = logging.getLogger("blueeye.errors")


class ApiError(Exception):
    """Raised by route handlers to return a controlled JSON error."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def register_error_handlers(app):
    @app.errorhandler(ApiError)
    def handle_api_error(exc):
        return jsonify(error=exc.message), exc.status

    @app.errorhandler(403)
    def handle_403(exc):
        return jsonify(error="forbidden: invalid certificate or unknown CN"), 403

    @app.errorhandler(404)
    def handle_404(exc):
        return jsonify(error="not found"), 404

    @app.errorhandler(500)
    def handle_500(exc):
        return jsonify(error="internal server error"), 500

    @app.errorhandler(Exception)
    def handle_uncaught(exc):
        # HTTP exceptions keep their own status; everything else is a 500.
        if isinstance(exc, HTTPException):
            return jsonify(error=exc.description), exc.code
        log.exception("unhandled exception")
        return jsonify(error="internal server error"), 500
