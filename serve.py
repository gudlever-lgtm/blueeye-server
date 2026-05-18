"""mTLS-enabled server entry point.

Runs the Flask app over the werkzeug server with a TLS context that requests
and verifies client certificates. The verified peer certificate is injected
into the WSGI environ as ``peercert`` so the application can authorize agents
by their certificate Common Name.

Certificates that are presented but not signed by the configured CA are
rejected during the TLS handshake. Requests with no client certificate reach
the app, where certificate-protected routes return HTTP 403.
"""
import ssl

from werkzeug.serving import WSGIRequestHandler, run_simple

from app import create_app
from app.config import Config


class MTLSRequestHandler(WSGIRequestHandler):
    """Adds the verified client certificate to the WSGI environ."""

    def make_environ(self):
        environ = super().make_environ()
        try:
            environ["peercert"] = self.connection.getpeercert()
        except Exception:
            environ["peercert"] = None
        return environ


def build_ssl_context():
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(Config.SERVER_CERT, Config.SERVER_KEY)
    context.load_verify_locations(Config.CA_CERT_PATH)
    # OPTIONAL: a presented cert must verify against the CA, but a request
    # with no cert still reaches the app (which then returns 403).
    context.verify_mode = ssl.CERT_OPTIONAL
    return context


def main():
    app = create_app()
    run_simple(
        "0.0.0.0",
        Config.PORT,
        app,
        ssl_context=build_ssl_context(),
        request_handler=MTLSRequestHandler,
        threaded=True,
    )


if __name__ == "__main__":
    main()
