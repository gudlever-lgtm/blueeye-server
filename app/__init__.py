"""BlueEye server application factory."""
import logging

from flask import Flask, jsonify

from .config import Config
from .dashboard import bp as dashboard_bp
from .db import init_schema
from .errors import register_error_handlers
from .routes.agents import bp as agents_bp
from .routes.jobs import bp as jobs_bp


def create_app():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    app = Flask(__name__)
    app.config.from_object(Config)

    register_error_handlers(app)
    app.register_blueprint(agents_bp)
    app.register_blueprint(jobs_bp)
    app.register_blueprint(dashboard_bp)

    @app.get("/health")
    def health():
        return jsonify(status="ok")

    init_schema()
    return app
